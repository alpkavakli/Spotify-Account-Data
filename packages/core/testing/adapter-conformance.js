"use strict";

// The StorageAdapter conformance suite — the executable version of the contract
// in src/storage.js.
//
// Every adapter must pass this identical suite. That is what makes Liskov
// substitution a fact instead of a hope: when PostgresAdapter lands it runs
// exactly these tests, so any place it behaves differently from SqliteAdapter
// (return types, ordering, merge semantics, index sync) fails here rather than
// silently in production.
//
// Rules for anything added to this file:
//   - Assert CONTRACT behavior only — never SQL, table names, or engine quirks.
//     Backend-specific tests belong in that adapter's own test file.
//   - Assert value TYPES, not just values. "count comes back as a number" is a
//     real portability constraint (node-postgres hands back COUNT(*) as a
//     string unless told otherwise), and the host does arithmetic on these.
//   - Use `await` on every adapter call, even against a synchronous adapter.
//
// Usage from an adapter's test file:
//   describeStorageAdapter({ name: "SqliteAdapter", createAdapter: () => ... });

const test = require("node:test");
const assert = require("node:assert/strict");

const { matchKey } = require("../src/matching");
const { SONGS, seed } = require("./fixtures");

/**
 * @param {object} opts
 * @param {string} opts.name                        label for the test output
 * @param {() => Promise<object>|object} opts.createAdapter  a fresh, EMPTY adapter
 * @param {(store: object) => Promise<void>} [opts.destroyAdapter]  defaults to store.close()
 */
function describeStorageAdapter({ name, createAdapter, destroyAdapter }) {
  test.describe(`StorageAdapter conformance — ${name}`, () => {
    let store;

    test.beforeEach(async () => {
      store = await createAdapter();
    });

    test.afterEach(async () => {
      if (!store) return;
      if (destroyAdapter) await destroyAdapter(store);
      else await store.close();
      store = null;
    });

    // ── ingest ──────────────────────────────────────────────────────────────

    test.describe("upsertSongs", () => {
      test.it("starts empty", async () => {
        const { tracks } = await store.getStatus();
        assert.equal(tracks, 0);
        assert.equal(typeof tracks, "number");
      });

      test.it("inserts songs and reports how many", async () => {
        const result = await store.upsertSongs(SONGS);
        assert.equal(result.inserted, SONGS.length);
        assert.equal((await store.getStatus()).tracks, SONGS.length);
      });

      test.it("assigns every song a distinct numeric id", async () => {
        await store.upsertSongs(SONGS);
        const rows = await store.getSongsNeedingLyrics({});
        const ids = rows.map((r) => r.id);
        assert.equal(new Set(ids).size, SONGS.length);
        for (const id of ids) assert.equal(typeof id, "number");
      });

      test.it("treats match_key as the identity — re-ingesting does not duplicate", async () => {
        await store.upsertSongs(SONGS);
        await store.upsertSongs(SONGS);
        assert.equal((await store.getStatus()).tracks, SONGS.length);
      });

      test.it("merges on conflict: keeps the first album/uri, maxes in_library, replaces counts", async () => {
        // The merge rules are not arbitrary. album/uri are COALESCEd because the
        // first source to supply one is as good as any and re-ingest must not
        // erase it; in_library is MAXed because being in the library once is
        // sticky; play_count/ms_played/playlists are REPLACED because ingest
        // recomputes them from the whole export every run — adding would
        // double-count on the second run.
        const first = {
          match_key: matchKey("Test Artist", "Test Track"),
          artist: "Test Artist",
          track: "Test Track",
          album: "First Album",
          uri: "spotify:track:first",
          in_library: 1,
          play_count: 10,
          stream_count: 8,
          ms_played: 1000,
          playlists: ["A"],
        };
        await store.upsertSongs([first]);
        await store.upsertSongs([
          { ...first, album: "Second Album", uri: "spotify:track:second", in_library: 0, play_count: 4, stream_count: 3, ms_played: 400, playlists: ["B"] },
        ]);

        const [{ id }] = await store.getSongsNeedingLyrics({});
        const row = await store.getSong(id);
        assert.equal(row.album, "First Album", "album must not be overwritten");
        assert.equal(row.uri, "spotify:track:first", "uri must not be overwritten");
        assert.equal(row.in_library, 1, "in_library must not drop back to 0");
        assert.equal(row.play_count, 4, "play_count must be replaced, not added");
        assert.equal(row.stream_count, 3, "stream_count must be replaced, not added");
        assert.equal(row.ms_played, 400, "ms_played must be replaced, not added");
        assert.deepEqual(JSON.parse(row.playlists), ["B"], "playlists must be replaced");
      });

      test.it("fills in a previously-missing album/uri on a later ingest", async () => {
        const base = {
          match_key: matchKey("Test Artist", "Test Track"),
          artist: "Test Artist",
          track: "Test Track",
          album: null,
          uri: null,
          in_library: 0,
          play_count: 1,
          stream_count: 1,
          ms_played: 100,
          playlists: [],
        };
        await store.upsertSongs([base]);
        await store.upsertSongs([{ ...base, album: "Found It", uri: "spotify:track:found" }]);

        const [{ id }] = await store.getSongsNeedingLyrics({});
        const row = await store.getSong(id);
        assert.equal(row.album, "Found It");
        assert.equal(row.uri, "spotify:track:found");
      });

      test.it("is atomic — one bad row rolls the whole batch back", async () => {
        // Atomicity is the A in the ACID discipline this project holds to: a
        // half-applied ingest is worse than a failed one, because nothing tells
        // you it happened.
        await store.upsertSongs(SONGS);
        const before = (await store.getStatus()).tracks;

        const good = { ...SONGS[0], match_key: "brand|||new", artist: "Brand", track: "New" };
        const bad = { ...SONGS[0], match_key: null };

        await assert.rejects(async () => store.upsertSongs([good, bad]));
        assert.equal(
          (await store.getStatus()).tracks,
          before,
          "the valid row in the failed batch must not have been kept"
        );
      });

      test.it("accepts an empty batch", async () => {
        const result = await store.upsertSongs([]);
        assert.equal(result.inserted, 0);
      });
    });

    // ── search ──────────────────────────────────────────────────────────────

    test.describe("searchByLyrics", () => {
      test.beforeEach(async () => {
        await seed(store);
      });

      test.it("finds songs whose lyrics contain the word", async () => {
        const rows = await store.searchByLyrics('"door"');
        assert.deepEqual(
          rows.map((r) => r.track),
          ["Open Door", "Two Doors Down"]
        );
      });

      test.it("stems — searching 'door' matches a body that only says 'doors'", async () => {
        // This is why the FTS index uses a porter stemmer. A Postgres adapter
        // must configure an equivalent stemming dictionary or this fails.
        const rows = await store.searchByLyrics('"door"');
        assert.ok(
          rows.some((r) => r.track === "Two Doors Down"),
          "plural-only body was not matched"
        );
      });

      test.it("distinguishes plays from streams", async () => {
        // play_count counts every play; stream_count counts only those past the
        // skip threshold. A backend that maps both to the same column passes
        // every other test in this suite and is still wrong.
        const [row] = await store.searchByLyrics('"door"');
        assert.equal(row.play_count, 30);
        assert.equal(row.stream_count, 24);
      });

      test.it("orders by play_count descending", async () => {
        const rows = await store.searchByLyrics('"door"');
        const counts = rows.map((r) => r.play_count);
        assert.deepEqual(counts, [...counts].sort((a, b) => b - a));
        assert.equal(counts[0], 30);
      });

      test.it("excludes songs that do not contain the word", async () => {
        const rows = await store.searchByLyrics('"door"');
        assert.ok(!rows.some((r) => r.track === "Silent Field"));
      });

      test.it("returns no rows for a word nobody sings", async () => {
        assert.deepEqual(await store.searchByLyrics('"xylophone"'), []);
      });

      test.it("never returns songs without ok lyrics", async () => {
        const rows = await store.searchByLyrics('"the"');
        for (const r of rows) {
          assert.ok(r.body, `${r.track} came back with no lyric body`);
        }
      });

      test.it("returns every field the host renders, with the right types", async () => {
        const [row] = await store.searchByLyrics('"door"');
        assert.equal(typeof row.id, "number");
        assert.equal(typeof row.artist, "string");
        assert.equal(typeof row.track, "string");
        assert.equal(typeof row.play_count, "number");
        assert.equal(typeof row.stream_count, "number");
        assert.equal(typeof row.in_library, "number", "in_library is 0|1, the host does !!");
        assert.equal(typeof row.body, "string");
        assert.equal(typeof row.snippet, "string");
        assert.ok("album" in row && "uri" in row);
      });

      test.it("returns playlists as a JSON array string (the host parses it)", async () => {
        const [row] = await store.searchByLyrics('"door"');
        assert.equal(typeof row.playlists, "string");
        assert.deepEqual(JSON.parse(row.playlists), ["Morning"]);
      });

      test.it("marks the matched term in the snippet with [[ ]]", async () => {
        const [row] = await store.searchByLyrics('"door"');
        assert.match(row.snippet, /\[\[/);
        assert.match(row.snippet, /\]\]/);
        assert.match(row.snippet.toLowerCase(), /\[\[door/);
      });
    });

    // ── single-song reads ───────────────────────────────────────────────────

    test.describe("getSong / getSongsByIds", () => {
      let ids;
      test.beforeEach(async () => {
        ids = await seed(store);
      });

      test.it("returns the full song with its lyric status and body", async () => {
        const row = await store.getSong(ids.get(SONGS[0].match_key));
        assert.equal(row.artist, "Aurora Vale");
        assert.equal(row.track, "Open Door");
        assert.equal(row.album, "First Light");
        assert.equal(row.uri, "spotify:track:s1");
        assert.equal(row.in_library, 1);
        assert.equal(row.play_count, 30);
        assert.equal(row.stream_count, 24);
        assert.equal(row.ms_played, 5_400_000);
        assert.equal(row.status, "ok");
        assert.match(row.body, /opened the door/);
      });

      test.it("returns a song that has no lyric row, with a falsy status", async () => {
        // The host turns a falsy status into "pending"; it must not be an error.
        const row = await store.getSong(ids.get(SONGS[5].match_key));
        assert.equal(row.track, "No Lyrics Yet");
        assert.ok(!row.status, `expected no status, got ${row.status}`);
        assert.ok(!row.body);
      });

      test.it("accepts a numeric-string id (routes pass req.params straight through)", async () => {
        const id = ids.get(SONGS[0].match_key);
        const row = await store.getSong(String(id));
        assert.equal(row.id, id);
      });

      test.it("returns null for an unknown id", async () => {
        assert.equal(await store.getSong(999999), null);
      });

      test.it("getSongsByIds returns only the requested songs", async () => {
        const wanted = [ids.get(SONGS[0].match_key), ids.get(SONGS[2].match_key)];
        const rows = await store.getSongsByIds(wanted);
        assert.equal(rows.length, 2);
        assert.deepEqual(rows.map((r) => r.id).sort(), [...wanted].sort());
        for (const r of rows) {
          assert.deepEqual(Object.keys(r).sort(), ["artist", "id", "track", "uri"]);
        }
      });

      test.it("getSongsByIds accepts numeric strings and ignores unknown ids", async () => {
        const id = ids.get(SONGS[0].match_key);
        const rows = await store.getSongsByIds([String(id), 999999]);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].id, id);
      });
    });

    // ── lyrics ──────────────────────────────────────────────────────────────

    test.describe("getSongsNeedingLyrics", () => {
      test.it("returns every song when none have been processed", async () => {
        await store.upsertSongs(SONGS);
        assert.equal((await store.getSongsNeedingLyrics({})).length, SONGS.length);
      });

      test.it("returns only the song with no lyric row once the rest are done", async () => {
        await seed(store);
        const pending = await store.getSongsNeedingLyrics({});
        assert.deepEqual(
          pending.map((r) => r.track),
          ["No Lyrics Yet"]
        );
      });

      test.it("skips notfound and instrumental — those are answers, not gaps", async () => {
        await seed(store);
        const pending = await store.getSongsNeedingLyrics({});
        assert.ok(!pending.some((r) => r.track === "Missing Words"));
        assert.ok(!pending.some((r) => r.track === "Instrumental Interlude"));
      });

      test.it("includes error rows only when retryErrors is set", async () => {
        const ids = await seed(store);
        const errored = ids.get(SONGS[4].match_key);
        await store.saveLyrics(errored, { status: "error", source: "boom", body: null });

        const without = await store.getSongsNeedingLyrics({});
        assert.ok(!without.some((r) => r.id === errored));

        const withRetry = await store.getSongsNeedingLyrics({ retryErrors: true });
        assert.ok(withRetry.some((r) => r.id === errored));
      });

      test.it("orders most-played first, and returns only what the fetcher needs", async () => {
        await store.upsertSongs(SONGS);
        const rows = await store.getSongsNeedingLyrics({});
        const counts = rows.map((r) => SONGS.find((s) => s.track === r.track).play_count);
        assert.deepEqual(counts, [...counts].sort((a, b) => b - a));
        assert.deepEqual(Object.keys(rows[0]).sort(), ["artist", "id", "track"]);
      });
    });

    test.describe("saveLyrics", () => {
      let ids;
      test.beforeEach(async () => {
        ids = await seed(store);
      });

      test.it("is an upsert — saving twice does not create a second row", async () => {
        const id = ids.get(SONGS[0].match_key);
        await store.saveLyrics(id, { status: "ok", source: "lrclib", body: "new body" });
        const row = await store.getSong(id);
        assert.equal(row.body, "new body");
        assert.equal((await store.getStatus()).tracks, SONGS.length);
      });

      test.it("adds an ok result to the search index", async () => {
        const id = ids.get(SONGS[5].match_key);
        await store.saveLyrics(id, {
          status: "ok",
          source: "lrclib",
          body: "a corridor of doors and quiet rooms",
        });
        const rows = await store.searchByLyrics('"corridor"');
        assert.deepEqual(rows.map((r) => r.id), [id]);
      });

      test.it("removes a song from the index when its lyrics stop being ok", async () => {
        // Re-running the fetcher can turn a hit into a miss. If the index is not
        // cleaned up, search keeps returning a song whose body is gone — and the
        // host then counts occurrences against null.
        const id = ids.get(SONGS[0].match_key);
        await store.saveLyrics(id, { status: "notfound", source: null, body: null });
        const rows = await store.searchByLyrics('"door"');
        assert.ok(!rows.some((r) => r.id === id));
      });

      test.it("re-indexes the new body, not the old one", async () => {
        const id = ids.get(SONGS[0].match_key);
        await store.saveLyrics(id, { status: "ok", source: "lrclib", body: "lanterns only" });
        assert.ok(!(await store.searchByLyrics('"door"')).some((r) => r.id === id));
        assert.ok((await store.searchByLyrics('"lanterns"')).some((r) => r.id === id));
      });

      test.it("does not index an instrumental (there is no body to index)", async () => {
        const id = ids.get(SONGS[0].match_key);
        await store.saveLyrics(id, { status: "instrumental", source: "lrclib", body: null });
        assert.ok(!(await store.searchByLyrics('"door"')).some((r) => r.id === id));
        assert.equal((await store.getSong(id)).status, "instrumental");
      });
    });

    // ── aggregates ──────────────────────────────────────────────────────────

    test.describe("aggregates", () => {
      test.beforeEach(async () => {
        await seed(store);
      });

      test.it("getStatus counts tracks and groups lyric statuses", async () => {
        const { tracks, statuses } = await store.getStatus();
        assert.equal(tracks, 6);
        const byStatus = Object.fromEntries(statuses.map((s) => [s.status, s.count]));
        assert.deepEqual(byStatus, { ok: 3, instrumental: 1, notfound: 1 });
        for (const s of statuses) assert.equal(typeof s.count, "number");
      });

      test.it("getLyricStatusCounts matches getStatus's breakdown", async () => {
        const counts = await store.getLyricStatusCounts();
        assert.deepEqual(
          Object.fromEntries(counts.map((c) => [c.status, c.count])),
          { ok: 3, instrumental: 1, notfound: 1 }
        );
      });

      test.it("getOkLyricCount counts only ok rows", async () => {
        const n = await store.getOkLyricCount();
        assert.equal(n, 3);
        assert.equal(typeof n, "number");
      });

      test.it("getOkLyricBodies returns bodies with play counts, ok only", async () => {
        const rows = await store.getOkLyricBodies();
        assert.equal(rows.length, 3);
        for (const r of rows) {
          assert.equal(typeof r.body, "string");
          assert.equal(typeof r.play_count, "number");
        }
        assert.deepEqual(
          rows.map((r) => r.play_count).sort((a, b) => b - a),
          [30, 12, 5]
        );
      });

      test.it("getStats totals every track, artist, play and millisecond", async () => {
        const { totals } = await store.getStats();
        assert.equal(totals.tracks, 6);
        assert.equal(totals.artists, 4, "artists are counted distinctly");
        assert.equal(totals.plays, 57);
        assert.equal(totals.streams, 44, "streams are counted separately from plays");
        assert.equal(totals.ms, 8_700_000);
        for (const [k, v] of Object.entries(totals)) {
          assert.equal(typeof v, "number", `totals.${k} must be a number, the host divides it`);
        }
      });

      test.it("getStats.topSongs excludes never-played songs and sorts by time listened", async () => {
        const { topSongs } = await store.getStats();
        assert.deepEqual(
          topSongs.map((s) => s.track),
          ["Open Door", "Two Doors Down", "Silent Field", "No Lyrics Yet", "Missing Words"]
        );
        assert.ok(!topSongs.some((s) => s.track === "Instrumental Interlude"));
        assert.deepEqual(
          topSongs.map((s) => [s.play_count, s.stream_count]),
          [[30, 24], [12, 9], [5, 4], [7, 5], [3, 2]]
        );
      });

      test.it("getStats.topArtists groups by artist and sorts by time listened", async () => {
        const { topArtists } = await store.getStats();
        assert.deepEqual(
          topArtists.map((a) => [a.artist, a.songs, a.plays, a.streams, a.ms]),
          [
            ["Aurora Vale", 2, 30, 24, 5_400_000],
            ["Kestrel Line", 1, 12, 9, 1_800_000],
            ["Marble Hound", 1, 5, 4, 900_000],
            ["Nine Volt", 2, 10, 7, 600_000],
          ]
        );
      });
    });

    // ── spotify auth + uri cache ────────────────────────────────────────────

    test.describe("auth", () => {
      test.it("has no session before login", async () => {
        assert.equal(await store.getAuth(), null);
      });

      test.it("stores and returns tokens", async () => {
        await store.saveTokens({ access_token: "at", refresh_token: "rt", expires_at: 123 });
        const row = await store.getAuth();
        assert.equal(row.access_token, "at");
        assert.equal(row.refresh_token, "rt");
        assert.equal(row.expires_at, 123);
      });

      test.it("overwrites tokens on re-login rather than accumulating sessions", async () => {
        await store.saveTokens({ access_token: "a1", refresh_token: "r1", expires_at: 1 });
        await store.saveTokens({ access_token: "a2", refresh_token: "r2", expires_at: 2 });
        assert.equal((await store.getAuth()).access_token, "a2");
      });

      test.it("attaches the Spotify identity to the stored session", async () => {
        await store.saveTokens({ access_token: "at", refresh_token: "rt", expires_at: 1 });
        await store.setAuthUser({ user_id: "spotify-user", display_name: "Alp" });
        const row = await store.getAuth();
        assert.equal(row.user_id, "spotify-user");
        assert.equal(row.display_name, "Alp");
        assert.equal(row.access_token, "at", "setting the user must not clear the tokens");
      });

      test.it("clearAuth removes the session", async () => {
        await store.saveTokens({ access_token: "at", refresh_token: "rt", expires_at: 1 });
        await store.clearAuth();
        assert.equal(await store.getAuth(), null);
      });

      test.it("clearAuth on an empty store is a no-op, not an error", async () => {
        await store.clearAuth();
        assert.equal(await store.getAuth(), null);
      });
    });

    test.describe("meta", () => {
      test.it("returns an empty object before anything is stored", async () => {
        assert.deepEqual(await store.getMeta(), {});
      });

      test.it("stores and returns keys", async () => {
        await store.setMeta({ history_from: "2019-03-04", history_to: "2026-04-17" });
        assert.deepEqual(await store.getMeta(), {
          history_from: "2019-03-04",
          history_to: "2026-04-17",
        });
      });

      test.it("upserts — a second write updates rather than duplicating", async () => {
        await store.setMeta({ history_to: "2026-01-01" });
        await store.setMeta({ history_to: "2026-04-17" });
        assert.deepEqual(await store.getMeta(), { history_to: "2026-04-17" });
      });

      test.it("merges with keys written earlier", async () => {
        await store.setMeta({ a: "1" });
        await store.setMeta({ b: "2" });
        assert.deepEqual(await store.getMeta(), { a: "1", b: "2" });
      });

      test.it("returns values as strings, whatever went in", async () => {
        // Metadata is display material, not arithmetic. Storing it as text keeps
        // one column usable for dates, numbers and flags alike.
        await store.setMeta({ skip_threshold_ms: 30000 });
        assert.equal((await store.getMeta()).skip_threshold_ms, "30000");
      });

      test.it("round-trips a null", async () => {
        await store.setMeta({ history_from: null });
        assert.equal((await store.getMeta()).history_from, null);
      });

      test.it("accepts an empty write", async () => {
        await store.setMeta({});
        assert.deepEqual(await store.getMeta(), {});
      });
    });

    test.describe("setSongUri", () => {
      test.it("caches a resolved Spotify URI onto the song", async () => {
        const ids = await seed(store);
        const id = ids.get(SONGS[1].match_key);
        assert.equal((await store.getSong(id)).uri, null);

        await store.setSongUri(id, "spotify:track:resolved");
        assert.equal((await store.getSong(id)).uri, "spotify:track:resolved");
      });
    });
  });
}

module.exports = { describeStorageAdapter };
