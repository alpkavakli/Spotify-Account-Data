"use strict";

// The two background jobs, called directly rather than through pg-boss.
//
// They are plain async functions taking their dependencies, so these tests need
// no queue at all — which keeps them fast and means the queue stays swappable.
// pg-boss's own job is delivery, and that is pg-boss's to test.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { makeZip, makeSpotifyExportZip } = require("@lyricsearch/core/testing/make-zip");
const { LocalBlobStore } = require("../src/blob-store");
const { PostgresAdapter } = require("../src/postgres-adapter");
const { parseUpload } = require("../src/jobs/parse-upload");
const { fetchPendingLyrics } = require("../src/jobs/fetch-lyrics");
const { pendingSongs, catalogueStats } = require("../src/lyric-catalog");
const { skipWithoutPostgres, freshDatabase, createUser } = require("./helpers/pg");

const skip = skipWithoutPostgres();

// --- fetch mocking, for the lyric job ---
function mockFetch(t, handler) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    calls.push(String(url));
    return handler(String(url));
  });
  return calls;
}

/**
 * A hit for whatever song the URL asked about.
 *
 * It has to echo the requested artist/track back: core's pickBest scores the
 * result against what was searched for and rejects a mismatch, which is exactly
 * what stops a cover band's lyrics being attached to your song.
 */
const lrclibHit = (url, body = "I opened the door") => {
  const params = new URL(url).searchParams;
  return new Response(
    JSON.stringify([
      {
        artistName: params.get("artist_name") || "Aurora Vale",
        trackName: params.get("track_name") || "Open Door",
        plainLyrics: body,
        instrumental: false,
      },
    ]),
    { status: 200, headers: { "content-type": "application/json" } }
  );
};

const lrclibMiss = () =>
  new Response("[]", { status: 200, headers: { "content-type": "application/json" } });

test.describe("background jobs", { skip }, () => {
  let pool;
  let blobStore;
  let blobDir;

  test.before(async () => {
    pool = await freshDatabase("jobs");
    blobDir = fs.mkdtempSync(path.join(os.tmpdir(), "lyricsearch-job-blobs-"));
    blobStore = new LocalBlobStore(blobDir);
  });

  test.after(async () => {
    await pool?.end();
    if (blobDir) fs.rmSync(blobDir, { recursive: true, force: true });
  });

  test.beforeEach(async () => {
    await pool.query("TRUNCATE users, songs RESTART IDENTITY CASCADE");
  });

  /** A user with a pending upload of `buffer`. */
  async function queueUpload(buffer, filename = "export.zip") {
    const userId = await createUser(pool);
    const key = await blobStore.put(buffer);
    const { rows } = await pool.query(
      `INSERT INTO uploads (user_id, blob_key, filename, bytes)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [userId, key, filename, buffer.length]
    );
    return { userId, uploadId: rows[0].id };
  }

  const uploadRow = async (id) =>
    (await pool.query("SELECT * FROM uploads WHERE id = $1", [id])).rows[0];

  // ── parse-upload ────────────────────────────────────────────────────────

  test.describe("parseUpload", () => {
    test.it("turns an export into the user's library", async () => {
      const { userId, uploadId } = await queueUpload(makeSpotifyExportZip());

      const result = await parseUpload({ pool, blobStore, uploadId });
      assert.equal(result.status, "done");
      assert.equal(result.songs, 1);

      const store = new PostgresAdapter(pool, { userId });
      assert.equal((await store.getStatus()).tracks, 1);
      const [song] = (await store.getStats()).topSongs;
      assert.equal(song.track, "Open Door");
      assert.equal(song.artist, "Aurora Vale");
    });

    test.it("merges library, playlists and history into one song", async () => {
      // The same song appears in all three files; it must not land three times.
      const { userId, uploadId } = await queueUpload(makeSpotifyExportZip());
      await parseUpload({ pool, blobStore, uploadId });

      const store = new PostgresAdapter(pool, { userId });
      const song = await store.getSong((await store.getSongsNeedingLyrics({}))[0].id);
      assert.equal(song.in_library, 1);
      assert.deepEqual(JSON.parse(song.playlists), ["Morning"]);
      assert.equal(song.play_count, 1);
      assert.equal(song.stream_count, 1, "200s of listening is well past the 30s threshold");
    });

    test.it("marks the upload done and records how many songs it found", async () => {
      const { uploadId } = await queueUpload(makeSpotifyExportZip());
      await parseUpload({ pool, blobStore, uploadId });

      const row = await uploadRow(uploadId);
      assert.equal(row.status, "done");
      assert.equal(row.songs_found, 1);
      assert.ok(row.processed_at);
      assert.equal(row.error, null);
    });

    test.it("records the coverage window and skip threshold", async () => {
      // So the UI can say what period the numbers cover instead of implying
      // they are all-time.
      const { userId, uploadId } = await queueUpload(makeSpotifyExportZip());
      await parseUpload({ pool, blobStore, uploadId });

      const meta = await new PostgresAdapter(pool, { userId }).getMeta();
      assert.equal(meta.history_from, "2025-04-16");
      assert.equal(meta.history_source, "account-data");
      assert.equal(meta.skip_threshold_ms, "30000");
      assert.ok(meta.ingested_at);
    });

    test.it("recognises an extended-history export", async () => {
      const { userId, uploadId } = await queueUpload(
        makeSpotifyExportZip({
          extended: true,
          histories: [[{
            ts: "2019-03-04T08:00:00Z",
            ms_played: 200000,
            master_metadata_track_name: "Open Door",
            master_metadata_album_artist_name: "Aurora Vale",
            spotify_track_uri: "spotify:track:xyz",
          }]],
        })
      );
      await parseUpload({ pool, blobStore, uploadId });

      const meta = await new PostgresAdapter(pool, { userId }).getMeta();
      assert.equal(meta.history_source, "extended");
      assert.equal(meta.history_from, "2019-03-04");
    });

    test.it("is safe to run twice — a redelivered job does not double-count", async () => {
      // At-least-once is the only guarantee a queue gives, so the job has to
      // claim its row and the second attempt must find nothing to claim.
      const { userId, uploadId } = await queueUpload(makeSpotifyExportZip());

      const first = await parseUpload({ pool, blobStore, uploadId });
      const second = await parseUpload({ pool, blobStore, uploadId });

      assert.equal(first.status, "done");
      assert.equal(second.status, "skipped");
      assert.equal((await new PostgresAdapter(pool, { userId }).getStatus()).tracks, 1);
    });

    test.it("adds a second upload to the same library without duplicating songs", async () => {
      const { userId, uploadId } = await queueUpload(makeSpotifyExportZip());
      await parseUpload({ pool, blobStore, uploadId });

      // Same songs plus one more, as if the extended export arrived later.
      const key = await blobStore.put(
        makeSpotifyExportZip({
          library: {
            tracks: [
              { artist: "Aurora Vale", track: "Open Door" },
              { artist: "Kestrel Line", track: "Two Doors Down" },
            ],
          },
        })
      );
      const { rows } = await pool.query(
        "INSERT INTO uploads (user_id, blob_key) VALUES ($1, $2) RETURNING id",
        [userId, key]
      );
      await parseUpload({ pool, blobStore, uploadId: rows[0].id });

      assert.equal((await new PostgresAdapter(pool, { userId }).getStatus()).tracks, 2);
    });

    test.it("gives two users their own libraries from identical exports", async () => {
      const a = await queueUpload(makeSpotifyExportZip());
      const b = await queueUpload(makeSpotifyExportZip());
      await parseUpload({ pool, blobStore, uploadId: a.uploadId });
      await parseUpload({ pool, blobStore, uploadId: b.uploadId });

      assert.equal((await new PostgresAdapter(pool, { userId: a.userId }).getStatus()).tracks, 1);
      assert.equal((await new PostgresAdapter(pool, { userId: b.userId }).getStatus()).tracks, 1);

      const { rows } = await pool.query("SELECT count(*)::int AS n FROM songs");
      assert.equal(rows[0].n, 1, "the shared song must be stored once globally");
    });

    // ── failures the user has to be told about ────────────────────────────

    test.it("fails the upload with a readable reason when the file is not a zip", async () => {
      const { uploadId } = await queueUpload(Buffer.from("this is not a zip"));
      const result = await parseUpload({ pool, blobStore, uploadId });

      assert.equal(result.status, "failed");
      const row = await uploadRow(uploadId);
      assert.equal(row.status, "failed");
      assert.match(row.error, /not a zip file/);
    });

    test.it("fails when the zip holds nothing we recognise", async () => {
      const { uploadId } = await queueUpload(makeZip({ "holiday-photo.jpg": "not json" }));
      const result = await parseUpload({ pool, blobStore, uploadId });

      assert.equal(result.status, "failed");
      assert.match((await uploadRow(uploadId)).error, /no Spotify data found/);
    });

    test.it("names the broken file when the JSON is malformed", async () => {
      const { uploadId } = await queueUpload(
        makeZip({ "Spotify Account Data/YourLibrary.json": "{oops" })
      );
      await parseUpload({ pool, blobStore, uploadId });
      assert.match((await uploadRow(uploadId)).error, /YourLibrary\.json is not valid JSON/);
    });

    test.it("does not throw on a bad upload — it is the user's problem, not an incident", async () => {
      // Throwing would make the queue retry, and a corrupt zip is corrupt every
      // time. The row carries the reason to the uploads page instead.
      const { uploadId } = await queueUpload(Buffer.from("garbage"));
      await assert.doesNotReject(() => parseUpload({ pool, blobStore, uploadId }));
    });

    test.it("fails cleanly when the blob has gone missing", async () => {
      const userId = await createUser(pool);
      const { rows } = await pool.query(
        "INSERT INTO uploads (user_id, blob_key) VALUES ($1, $2) RETURNING id",
        [userId, "2020-01/" + "0".repeat(32)]
      );
      const result = await parseUpload({ pool, blobStore, uploadId: rows[0].id });
      assert.equal(result.status, "failed");
      assert.match((await uploadRow(rows[0].id)).error, /ENOENT/);
    });

    test.it("leaves the library untouched when parsing fails", async () => {
      const { userId, uploadId } = await queueUpload(Buffer.from("garbage"));
      await parseUpload({ pool, blobStore, uploadId });
      assert.equal((await new PostgresAdapter(pool, { userId }).getStatus()).tracks, 0);
    });

    test.it("skips an upload id that does not exist", async () => {
      assert.deepEqual(await parseUpload({ pool, blobStore, uploadId: 999999 }), {
        status: "skipped",
      });
    });

    test.it("honours a custom skip threshold", async () => {
      const { userId, uploadId } = await queueUpload(
        makeSpotifyExportZip({
          histories: [[{ endTime: "2025-04-16 17:48", artistName: "A", trackName: "B", msPlayed: 12000 }]],
          library: null,
          playlists: null,
        })
      );
      await parseUpload({ pool, blobStore, uploadId, skipThresholdMs: 10_000 });

      const store = new PostgresAdapter(pool, { userId });
      const [song] = (await store.getStats()).topSongs;
      assert.equal(song.play_count, 1);
      assert.equal(song.stream_count, 1, "12s counts as a listen at a 10s threshold");
    });
  });

  // ── the global lyric catalogue ──────────────────────────────────────────

  test.describe("lyric catalogue", () => {
    async function songOwnedBy(count, { artist = "Aurora Vale", track = "Open Door", plays = 1 } = {}) {
      const { rows } = await pool.query(
        "INSERT INTO songs (match_key, artist, track) VALUES ($1, $2, $3) RETURNING id",
        [`${artist}|||${track}`.toLowerCase(), artist, track]
      );
      const songId = rows[0].id;
      for (let i = 0; i < count; i++) {
        await pool.query(
          "INSERT INTO user_songs (user_id, song_id, play_count) VALUES ($1, $2, $3)",
          [await createUser(pool), songId, plays]
        );
      }
      return songId;
    }

    test.it("queues the song the most users are waiting on first", async () => {
      // With a backlog, the fetch that unblocks the most people should happen
      // first.
      const rare = await songOwnedBy(1, { track: "Rare Song" });
      const popular = await songOwnedBy(3, { track: "Popular Song" });

      const pending = await pendingSongs(pool);
      assert.deepEqual(pending.map((p) => p.id), [popular, rare]);
      assert.equal(pending[0].owners, 3);
    });

    test.it("lists only songs that have no lyrics at all", async () => {
      const done = await songOwnedBy(1, { track: "Done" });
      const todo = await songOwnedBy(1, { track: "Todo" });
      await pool.query("INSERT INTO lyrics (song_id, status, body) VALUES ($1, 'ok', 'words')", [done]);

      assert.deepEqual((await pendingSongs(pool)).map((p) => p.id), [todo]);
    });

    test.it("treats notfound and instrumental as answered, not pending", async () => {
      const a = await songOwnedBy(1, { track: "Missing" });
      const b = await songOwnedBy(1, { track: "Instrumental" });
      await pool.query("INSERT INTO lyrics (song_id, status) VALUES ($1, 'notfound'), ($2, 'instrumental')", [a, b]);
      assert.deepEqual(await pendingSongs(pool), []);
    });

    test.it("re-queues errors only when asked", async () => {
      const song = await songOwnedBy(1);
      await pool.query("INSERT INTO lyrics (song_id, status) VALUES ($1, 'error')", [song]);

      assert.deepEqual(await pendingSongs(pool), []);
      assert.deepEqual((await pendingSongs(pool, { retryErrors: true })).map((p) => p.id), [song]);
    });

    test.it("reports catalogue-wide progress", async () => {
      const a = await songOwnedBy(1, { track: "A" });
      await songOwnedBy(1, { track: "B" });
      await pool.query("INSERT INTO lyrics (song_id, status, body) VALUES ($1, 'ok', 'x')", [a]);

      const stats = await catalogueStats(pool);
      assert.equal(stats.songs, 2);
      assert.equal(stats.processed, 1);
      assert.equal(stats.ok, 1);
      assert.equal(stats.pending, 1);
    });
  });

  // ── fetch-lyrics ────────────────────────────────────────────────────────

  test.describe("fetchPendingLyrics", () => {
    async function pendingSong(artist = "Aurora Vale", track = "Open Door") {
      const { rows } = await pool.query(
        "INSERT INTO songs (match_key, artist, track) VALUES ($1, $2, $3) RETURNING id",
        [`${artist}|||${track}`.toLowerCase(), artist, track]
      );
      await pool.query("INSERT INTO user_songs (user_id, song_id) VALUES ($1, $2)", [
        await createUser(pool),
        rows[0].id,
      ]);
      return rows[0].id;
    }

    test.it("fetches and stores lyrics", async (t) => {
      const songId = await pendingSong();
      mockFetch(t, (url) => lrclibHit(url));

      const counts = await fetchPendingLyrics({ pool, delayMs: 0 });
      assert.deepEqual(counts, { attempted: 1, ok: 1, notfound: 0, instrumental: 0, error: 0 });

      const { rows } = await pool.query("SELECT status, body FROM lyrics WHERE song_id = $1", [songId]);
      assert.equal(rows[0].status, "ok");
      assert.match(rows[0].body, /opened the door/);
    });

    test.it("makes the song searchable for EVERY user who owns it", async (t) => {
      // The whole argument for a global catalogue: one fetch, everybody
      // benefits, and LRCLIB is asked once no matter how many users own it.
      const songId = await pendingSong();
      const [alice, bob] = [await createUser(pool), await createUser(pool)];
      await pool.query(
        "INSERT INTO user_songs (user_id, song_id) VALUES ($1, $3), ($2, $3)",
        [alice, bob, songId]
      );

      const calls = mockFetch(t, (url) => lrclibHit(url));
      await fetchPendingLyrics({ pool, delayMs: 0 });

      assert.equal(calls.length, 1, "one song must cost exactly one lookup");
      for (const userId of [alice, bob]) {
        const hits = await new PostgresAdapter(pool, { userId }).searchByLyrics(["door"]);
        assert.deepEqual(hits.map((h) => h.id), [songId]);
      }
    });

    test.it("records a miss so the song is never looked up again", async (t) => {
      const songId = await pendingSong();
      mockFetch(t, () => lrclibMiss());

      const counts = await fetchPendingLyrics({ pool, delayMs: 0 });
      assert.equal(counts.notfound, 1);
      assert.equal(
        (await pool.query("SELECT status FROM lyrics WHERE song_id = $1", [songId])).rows[0].status,
        "notfound"
      );
      assert.deepEqual(await pendingSongs(pool), [], "a recorded miss is not pending");
    });

    test.it("records an error without stopping the run", async (t) => {
      // One song LRCLIB cannot answer for must not abandon the rest of the batch.
      await pendingSong("Bad Artist", "Bad Song");
      await pendingSong("Good Artist", "Good Song");

      mockFetch(t, (url) =>
        url.includes("Bad") ? new Response("", { status: 400 }) : lrclibHit(url)
      );

      const counts = await fetchPendingLyrics({ pool, delayMs: 0, concurrency: 1 });
      assert.equal(counts.attempted, 2);
      assert.equal(counts.error, 1);
      assert.equal(counts.ok, 1);

      const stats = await catalogueStats(pool);
      assert.equal(stats.processed, 2, "both songs must be recorded either way");
    });

    test.it("stores the failure reason on an errored song", async (t) => {
      const songId = await pendingSong();
      mockFetch(t, () => new Response("", { status: 400 }));

      await fetchPendingLyrics({ pool, delayMs: 0 });
      const { rows } = await pool.query("SELECT status, source FROM lyrics WHERE song_id = $1", [songId]);
      assert.equal(rows[0].status, "error");
      assert.match(rows[0].source, /lrclib 400/);
    });

    test.it("does nothing when the catalogue is complete", async (t) => {
      const calls = mockFetch(t, (url) => lrclibHit(url));
      const counts = await fetchPendingLyrics({ pool, delayMs: 0 });
      assert.equal(counts.attempted, 0);
      assert.equal(calls.length, 0);
    });

    test.it("respects the batch limit so one run cannot monopolise the worker", async (t) => {
      for (let i = 0; i < 5; i++) await pendingSong(`Artist ${i}`, `Track ${i}`);
      mockFetch(t, () => lrclibMiss());

      const counts = await fetchPendingLyrics({ pool, limit: 2, delayMs: 0 });
      assert.equal(counts.attempted, 2);
      assert.equal((await catalogueStats(pool)).pending, 3);
    });

    test.it("never re-fetches a song that already has lyrics", async (t) => {
      const songId = await pendingSong();
      await pool.query("INSERT INTO lyrics (song_id, status, body) VALUES ($1, 'ok', 'cached')", [songId]);

      const calls = mockFetch(t, (url) => lrclibHit(url));
      await fetchPendingLyrics({ pool, delayMs: 0 });
      assert.equal(calls.length, 0, "LRCLIB must be asked once per song, ever");
    });
  });
});
