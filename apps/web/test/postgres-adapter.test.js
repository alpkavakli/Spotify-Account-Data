"use strict";

// PostgresAdapter = the SAME conformance suite SqliteAdapter passes, plus the
// things that only exist because this backend is multi-tenant.
//
// The conformance run is the point of the whole architecture. If it passes,
// `core` and every route can hold either adapter without knowing which — the
// Liskov commitment in docs/01-DECISIONS.md, checked by execution rather than
// by intention.

const test = require("node:test");
const assert = require("node:assert/strict");

const { describeStorageAdapter } = require("@lyricsearch/core/testing/adapter-conformance");
const { SONGS, seed } = require("@lyricsearch/core/testing/fixtures");
const { PostgresAdapter } = require("../src/postgres-adapter");
const { skipWithoutPostgres, freshDatabase, createUser } = require("./helpers/pg");

const skip = skipWithoutPostgres();

// One migrated database for the file; the conformance suite gets a clean slate
// between tests via truncation (below).
let pool = null;

async function getPool() {
  if (!pool) pool = await freshDatabase("adapter");
  return pool;
}

/**
 * A fresh, EMPTY adapter for the conformance suite.
 *
 * "Empty" has to mean the GLOBAL catalogue too, not just a new user. The suite
 * asserts things like "the first album wins" using fixed match_keys, and songs
 * are shared across users — so a previous test's global row would leak into the
 * next test and make merge assertions fail for reasons that look like adapter
 * bugs. Truncating is a few milliseconds.
 */
async function createAdapter() {
  const p = await getPool();
  await p.query("TRUNCATE users, songs RESTART IDENTITY CASCADE");
  return new PostgresAdapter(p, { userId: await createUser(p) });
}

test.after(async () => {
  await pool?.end();
});

// ── the contract ──────────────────────────────────────────────────────────

if (!skip) {
  describeStorageAdapter({
    name: "PostgresAdapter",
    createAdapter,
    // close() is a no-op by design: the pool is shared by every tenant and by
    // the whole process, so an adapter must never end it.
    destroyAdapter: async () => {},
  });
}

// ── multi-tenancy: behavior SqliteAdapter cannot have ─────────────────────

test.describe("PostgresAdapter (backend-specific)", { skip }, () => {
  let p;

  test.before(async () => {
    p = await getPool();
  });

  /** Two adapters on two different users, sharing the database. */
  async function twoTenants() {
    await p.query("TRUNCATE users, songs RESTART IDENTITY CASCADE");
    const alice = new PostgresAdapter(p, { userId: await createUser(p) });
    const bob = new PostgresAdapter(p, { userId: await createUser(p) });
    return { alice, bob };
  }

  test.it("refuses to be constructed without a user", async () => {
    // An unscoped adapter would read across tenants. Failing loudly at
    // construction is the only safe default.
    assert.throws(() => new PostgresAdapter(p, {}), /requires a userId/);
    assert.throws(() => new PostgresAdapter(p, { userId: null }), /requires a userId/);
    assert.throws(() => new PostgresAdapter(null, { userId: 1 }), /requires a pg Pool/);
  });

  test.it("never shows one tenant another tenant's songs", async () => {
    const { alice, bob } = await twoTenants();
    await seed(alice);

    assert.equal((await alice.getStatus()).tracks, SONGS.length);
    assert.equal((await bob.getStatus()).tracks, 0, "bob must see an empty library");
    assert.deepEqual(await bob.searchByLyrics(["door"]), []);
    assert.deepEqual(await bob.getStats().then((s) => s.topSongs), []);
    assert.equal(await bob.getOkLyricCount(), 0);
  });

  test.it("does not let a tenant read another tenant's song by id", async () => {
    // The most direct attack there is: guess an id from someone else's library.
    const { alice, bob } = await twoTenants();
    const ids = await seed(alice);
    const id = ids.get(SONGS[0].match_key);

    assert.ok(await alice.getSong(id));
    assert.equal(await bob.getSong(id), null);
    assert.deepEqual(await bob.getSongsByIds([id]), []);
  });

  test.it("stores a shared song once, with independent per-user counts", async () => {
    // The storage argument for the whole design: the thousandth user to own a
    // song adds one narrow row, not another copy of it.
    const { alice, bob } = await twoTenants();
    const song = {
      match_key: "shared|||song",
      artist: "Shared",
      track: "Song",
      album: null,
      uri: null,
      in_library: 1,
      play_count: 30,
      stream_count: 24,
      ms_played: 5_000_000,
      playlists: ["Alice's list"],
    };

    await alice.upsertSongs([song]);
    await bob.upsertSongs([{ ...song, in_library: 0, play_count: 3, stream_count: 1, ms_played: 9_000, playlists: [] }]);

    const { rows } = await p.query("SELECT count(*)::int AS n FROM songs WHERE match_key = $1", [
      "shared|||song",
    ]);
    assert.equal(rows[0].n, 1, "the song must be stored once globally");

    const aliceSong = (await alice.getStats()).topSongs[0];
    const bobSong = (await bob.getStats()).topSongs[0];
    assert.equal(aliceSong.play_count, 30);
    assert.equal(bobSong.play_count, 3);
    assert.equal(aliceSong.id, bobSong.id, "same global song id for both users");
  });

  test.it("shares fetched lyrics with every user who owns the song", async () => {
    // The reason LRCLIB is only ever asked once per song, however many users
    // own it.
    const { alice, bob } = await twoTenants();
    const song = {
      match_key: "shared|||lyrics",
      artist: "Shared",
      track: "Lyrics",
      album: null,
      uri: null,
      in_library: 0,
      play_count: 1,
      stream_count: 1,
      ms_played: 1000,
      playlists: [],
    };
    await alice.upsertSongs([song]);
    await bob.upsertSongs([song]);

    const [{ id }] = await alice.getSongsNeedingLyrics({});
    await alice.saveLyrics(id, { status: "ok", source: "lrclib", body: "a corridor of doors" });

    assert.deepEqual(
      (await bob.searchByLyrics(["corridor"])).map((r) => r.id),
      [id],
      "bob should benefit from a fetch he never triggered"
    );
    assert.deepEqual(
      await bob.getSongsNeedingLyrics({}),
      [],
      "bob must not be asked to re-fetch what alice already fetched"
    );
  });

  test.it("shares a resolved Spotify URI globally", async () => {
    const { alice, bob } = await twoTenants();
    const song = {
      match_key: "shared|||uri",
      artist: "Shared",
      track: "Uri",
      album: null,
      uri: null,
      in_library: 0,
      play_count: 1,
      stream_count: 0,
      ms_played: 1,
      playlists: [],
    };
    await alice.upsertSongs([song]);
    await bob.upsertSongs([song]);

    const [{ id }] = await alice.getSongsNeedingLyrics({});
    await alice.setSongUri(id, "spotify:track:shared");

    assert.equal((await bob.getSong(id)).uri, "spotify:track:shared");
  });

  test.it("will not let a tenant write a URI onto a song they do not own", async () => {
    const { alice, bob } = await twoTenants();
    await seed(alice);
    const ids = await alice.getSongsNeedingLyrics({});
    const id = ids[0].id;

    await bob.setSongUri(id, "spotify:track:hijacked");
    assert.notEqual((await alice.getSong(id)).uri, "spotify:track:hijacked");
  });

  test.it("keeps each tenant's metadata and Spotify connection separate", async () => {
    const { alice, bob } = await twoTenants();

    await alice.setMeta({ history_from: "2019-03-04" });
    await alice.saveTokens({ access_token: "alice-token", refresh_token: "r", expires_at: 1 });
    await alice.setAuthUser({ user_id: "spotify-alice", display_name: "Alice" });

    assert.deepEqual(await bob.getMeta(), {});
    assert.equal(await bob.getAuth(), null);
    assert.equal((await alice.getAuth()).user_id, "spotify-alice");
  });

  test.it("keeps our account id and the Spotify user id apart", async () => {
    // getAuth() must report the SPOTIFY user id — core.spotify.createPlaylist
    // uses row.user_id as a Spotify identifier. Returning our bigint account id
    // would create playlists against a Spotify account that does not exist.
    const { alice } = await twoTenants();
    await alice.saveTokens({ access_token: "t", refresh_token: "r", expires_at: 1 });
    await alice.setAuthUser({ user_id: "spotify-handle", display_name: "A" });

    const auth = await alice.getAuth();
    assert.equal(auth.user_id, "spotify-handle");
    assert.notEqual(auth.user_id, String(alice.userId));
  });

  test.it("deleting the account removes the tenant's data but not the catalogue", async () => {
    const { alice, bob } = await twoTenants();
    await seed(alice);
    // Bob only claims the songs — seed() would try to fetch lyrics for them and
    // find nothing to do, because alice's fetch already filled the GLOBAL lyrics
    // table. That is the model working, and it is why seed() can only be used
    // once per database.
    await bob.upsertSongs(SONGS);
    await alice.setMeta({ k: "v" });

    await p.query("DELETE FROM users WHERE id = $1", [alice.userId]);

    assert.equal((await alice.getStatus()).tracks, 0);
    assert.deepEqual(await alice.getMeta(), {});
    assert.equal(
      (await bob.getStatus()).tracks,
      SONGS.length,
      "the other tenant must be untouched"
    );
    const { rows } = await p.query("SELECT count(*)::int AS n FROM songs");
    assert.ok(rows[0].n > 0, "the shared catalogue must survive an account deletion");
  });

  test.it("returns bigints as numbers, not strings", async () => {
    // node-postgres hands back int8 as a string by default. The contract says
    // these are numbers and the routes divide them.
    const { alice } = await twoTenants();
    await seed(alice);

    const { totals } = await alice.getStats();
    for (const [k, v] of Object.entries(totals)) {
      assert.equal(typeof v, "number", `totals.${k} came back as ${typeof v}`);
    }
    const song = (await alice.getStats()).topSongs[0];
    assert.equal(typeof song.id, "number");
    assert.equal(typeof song.ms_played, "number");
  });

  test.it("survives a listening time larger than int4", async () => {
    const { alice } = await twoTenants();
    await alice.upsertSongs([
      {
        match_key: "big|||ms",
        artist: "Big",
        track: "Ms",
        album: null,
        uri: null,
        in_library: 0,
        play_count: 22013,
        stream_count: 17503,
        ms_played: 3_725_461_745,
        playlists: [],
      },
    ]);
    assert.equal((await alice.getStats()).totals.ms, 3_725_461_745);
  });

  test.it("neutralises tsquery operators typed into the search box", async () => {
    // The Postgres counterpart of the FTS5 quoting test: plainto_tsquery
    // escapes everything, so `&` or `:*` is a search, not a syntax error.
    const { alice } = await twoTenants();
    await seed(alice);

    for (const words of [["&"], ["|"], ["!"], [":*"], ["("], ["a", "&", "b"]]) {
      await assert.doesNotReject(
        async () => alice.searchByLyrics(words),
        `${JSON.stringify(words)} must be a search, not a syntax error`
      );
    }
    assert.equal((await alice.searchByLyrics(["door"])).length, 2, "real words still work");
  });

  test.it("rolls back a failed ingest without leaving global songs behind", async () => {
    // Atomicity across TWO tables: a batch that fails on user_songs must not
    // leave orphan rows in the shared catalogue either.
    const { alice } = await twoTenants();
    const good = {
      match_key: "atomic|||good",
      artist: "A",
      track: "Good",
      album: null,
      uri: null,
      in_library: 0,
      play_count: 1,
      stream_count: 0,
      ms_played: 1,
      playlists: [],
    };
    await assert.rejects(() => alice.upsertSongs([good, { ...good, match_key: null }]));

    const { rows } = await p.query("SELECT count(*)::int AS n FROM songs WHERE match_key = $1", [
      "atomic|||good",
    ]);
    assert.equal(rows[0].n, 0, "the global song from a failed batch must be rolled back");
    assert.equal((await alice.getStatus()).tracks, 0);
  });

  test.it("does not end the shared pool when an adapter is closed", async () => {
    // Every request builds an adapter; if close() ended the pool the second
    // request would find a dead one.
    const { alice } = await twoTenants();
    await alice.close();
    assert.equal((await alice.getStatus()).tracks, 0, "pool should still be usable");
  });
});
