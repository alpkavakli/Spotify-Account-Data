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

  test.it("neutralises FTS5 operators typed into the search box", async () => {
    // FTS5 has its own query language, so a user searching for "AND" or "(" used
    // to be a syntax error rather than a search. The adapter now quotes every
    // word itself, which is why searchByLyrics takes plain words rather than a
    // pre-built expression: the engine's syntax is the adapter's problem.
    const store = tempStore();
    try {
      await seed(store);
      for (const words of [["AND"], ["("], ["*"], ["NEAR"], ["a", "OR", "b"], ["^"], ['do"or']]) {
        await assert.doesNotReject(
          async () => store.searchByLyrics(words),
          `${JSON.stringify(words)} must be a search, not a syntax error`
        );
      }
    } finally {
      await store.close();
    }
  });

  test.it("treats an operator word as a word to look for", async () => {
    // "and" is an FTS5 operator AND an English word that appears in the lyrics.
    // Quoted, it searches for the word — which is what the user meant.
    const store = tempStore();
    try {
      await seed(store);
      const hits = await store.searchByLyrics(["AND"]);
      assert.ok(hits.length > 0, "should find the songs whose lyrics say 'and'");
      for (const r of hits) assert.match(r.body.toLowerCase(), /\band\b/);
    } finally {
      await store.close();
    }
  });

  test.it("still finds real words after quoting", async () => {
    const store = tempStore();
    try {
      await seed(store);
      assert.equal((await store.searchByLyrics(["door"])).length, 2);
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
