"use strict";

// SqliteAdapter tests = the shared conformance suite + the handful of things
// that are genuinely SQLite-specific (file layout, WAL, FTS query syntax).
//
// Nothing here touches your real Data/spotify.db: every adapter is built in a
// throwaway directory under the OS temp dir and deleted afterwards.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { describeStorageAdapter } = require("@lyricsearch/core/testing/adapter-conformance");
const { seed } = require("@lyricsearch/core/testing/fixtures");
const { SqliteAdapter } = require("../src/sqlite-adapter");
const { tempStore, reopenStore, cleanupTempStores } = require("./helpers/temp-store");

test.after(cleanupTempStores);

// ── the contract ──────────────────────────────────────────────────────────

describeStorageAdapter({
  name: "SqliteAdapter",
  createAdapter: () => tempStore(),
});

// ── SQLite-specific behavior ──────────────────────────────────────────────

test.describe("SqliteAdapter (backend-specific)", () => {
  test.it("creates spotify.db inside the given data directory", async () => {
    const store = tempStore();
    try {
      assert.ok(fs.existsSync(path.join(store.dataDir, "spotify.db")));
    } finally {
      await store.close();
    }
  });

  test.it("creates the data directory if it does not exist", async () => {
    const parent = tempStore();
    const nested = path.join(parent.dataDir, "does-not-exist-yet");
    await parent.close();

    const store = new SqliteAdapter(nested);
    try {
      assert.ok(fs.existsSync(nested));
    } finally {
      await store.close();
    }
  });

  test.it("runs in WAL mode (concurrent reads while the fetcher writes)", async () => {
    const store = tempStore();
    try {
      const mode = store.db.prepare("PRAGMA journal_mode").get();
      assert.equal(String(Object.values(mode)[0]).toLowerCase(), "wal");
    } finally {
      await store.close();
    }
  });

  test.it("enforces the lyrics → tracks foreign key", async () => {
    // Consistency is enforced by the schema, not by app code: a lyric row for a
    // song that does not exist must be impossible.
    const store = tempStore();
    try {
      await assert.rejects(async () =>
        store.saveLyrics(4242, { status: "ok", source: "x", body: "y" })
      );
    } finally {
      await store.close();
    }
  });

  test.it("throws on malformed FTS syntax so the route can answer 400", async () => {
    // core.toFtsQuery quotes user input precisely so this cannot happen from the
    // UI, but the route still wraps the call in try/catch — this is the error it
    // is catching.
    //
    // The index must be seeded first: with an empty lyrics_fts, SQLite never
    // opens the FTS cursor and so never parses the match expression, and every
    // one of these silently returns zero rows instead of raising.
    const store = tempStore();
    try {
      await seed(store);
      await assert.rejects(async () => store.searchByLyrics('"unterminated'));
      await assert.rejects(async () => store.searchByLyrics("AND"));
      await assert.rejects(async () => store.searchByLyrics("(unbalanced"));
    } finally {
      await store.close();
    }
  });

  test.it("opens read-only without allowing writes", async () => {
    const store = tempStore();
    const dir = store.dataDir;
    await store.upsertSongs([
      {
        match_key: "a|||b",
        artist: "A",
        track: "B",
        album: null,
        uri: null,
        in_library: 0,
        play_count: 0,
        ms_played: 0,
        playlists: [],
      },
    ]);
    await store.close();

    const ro = reopenStore(dir, { readOnly: true });
    try {
      assert.equal((await ro.getStatus()).tracks, 1);
      await assert.rejects(async () => ro.setSongUri(1, "spotify:track:nope"));
    } finally {
      await ro.close();
    }
  });
});
