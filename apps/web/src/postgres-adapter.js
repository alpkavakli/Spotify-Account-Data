"use strict";

// Postgres implementation of the StorageAdapter contract — the hosted service's
// multi-tenant store.
//
// It is SCOPED TO ONE USER. Every instance carries a userId, and every query
// that touches per-user data filters by it inside this file. That is deliberate:
// tenant isolation is not something a route can forget to apply, because no
// route writes SQL. Reading another user's data would require a bug in here, not
// a missing `WHERE` somewhere in the API.
//
// What is per-user and what is global:
//   songs, lyrics          GLOBAL — the same words for everybody, stored once
//   user_songs, user_meta  per-user — play counts and library membership
//   spotify_accounts       per-user — the optional Spotify connection
//
// Everything else in apps/web depends on the StorageAdapter abstraction, never
// on this class. See docs/06-DATA-MODEL.md.

const { types } = require("pg");
const { StorageAdapter } = require("@lyricsearch/core/storage");

// node-postgres returns int8 (bigint) as a STRING, to avoid silently losing
// precision above 2^53. Correct in general, wrong for us: the contract says
// counts and ids are numbers, and the routes do arithmetic on them
// (`Math.round(totals.ms / 3600000)`). Our int8 values are row ids and
// millisecond totals — the largest realistic value is ~10^13, three orders of
// magnitude below the 9x10^15 where doubles start losing integers.
//
// This is the exact portability trap the conformance suite pre-registered by
// asserting `typeof === "number"` rather than just the value.
types.setTypeParser(types.builtins.INT8, (v) => (v === null ? null : Number(v)));

class PostgresAdapter extends StorageAdapter {
  /**
   * @param {import("pg").Pool} pool
   * @param {{userId: number|string}} opts  the tenant every query is scoped to
   */
  constructor(pool, { userId } = {}) {
    super();
    if (!pool) throw new Error("PostgresAdapter requires a pg Pool");
    if (userId === undefined || userId === null) {
      // Failing here rather than defaulting to "no filter" is the point: an
      // unscoped adapter would quietly read across tenants.
      throw new Error("PostgresAdapter requires a userId — every query is user-scoped");
    }
    this.pool = pool;
    this.userId = Number(userId);
  }

  /** Run `fn` inside a transaction on a single dedicated connection. */
  async #transaction(fn) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  // ── ingest ────────────────────────────────────────────────────────────────

  async upsertSongs(songs) {
    if (songs.length === 0) return { inserted: 0 };

    return this.#transaction(async (client) => {
      // Two statements, both set-based via unnest(): one round trip each rather
      // than one per song. Ingesting a real export is ~4000 songs.

      // 1. The global catalogue. album/uri are COALESCEd because the first
      //    source to supply one is as good as any, and another user's later
      //    ingest must not erase it.
      const { rows } = await client.query(
        `INSERT INTO songs (match_key, artist, track, album, uri)
         SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[])
         ON CONFLICT (match_key) DO UPDATE SET
           album = COALESCE(songs.album, EXCLUDED.album),
           uri   = COALESCE(songs.uri,   EXCLUDED.uri)
         RETURNING id, match_key`,
        [
          songs.map((s) => s.match_key),
          songs.map((s) => s.artist),
          songs.map((s) => s.track),
          songs.map((s) => s.album ?? null),
          songs.map((s) => s.uri ?? null),
        ]
      );

      const idByKey = new Map(rows.map((r) => [r.match_key, r.id]));

      // 2. This user's copy. Counts are REPLACED rather than added, because
      //    ingest recomputes them from the whole export every run — adding
      //    would double everything on the second upload. in_library is maxed:
      //    having saved a song once is sticky.
      await client.query(
        `INSERT INTO user_songs
           (user_id, song_id, in_library, play_count, stream_count, ms_played, playlists)
         SELECT $1, * FROM unnest(
           $2::bigint[], $3::smallint[], $4::int[], $5::int[], $6::bigint[], $7::jsonb[]
         )
         ON CONFLICT (user_id, song_id) DO UPDATE SET
           in_library   = GREATEST(user_songs.in_library, EXCLUDED.in_library),
           play_count   = EXCLUDED.play_count,
           stream_count = EXCLUDED.stream_count,
           ms_played    = EXCLUDED.ms_played,
           playlists    = EXCLUDED.playlists`,
        [
          this.userId,
          songs.map((s) => idByKey.get(s.match_key)),
          songs.map((s) => s.in_library ?? 0),
          songs.map((s) => s.play_count ?? 0),
          songs.map((s) => s.stream_count ?? 0),
          songs.map((s) => s.ms_played ?? 0),
          songs.map((s) => JSON.stringify(s.playlists ?? [])),
        ]
      );

      return { inserted: songs.length };
    });
  }

  // ── search & read ─────────────────────────────────────────────────────────

  /**
   * Words -> a tsquery.
   *
   * plainto_tsquery ANDs the terms and escapes everything itself, so a user
   * searching for `&`, `:*` or `(` gets a search rather than a syntax error —
   * the Postgres equivalent of the FTS5 quoting SqliteAdapter does.
   */
  async searchByLyrics(words) {
    const { rows } = await this.pool.query(
      `WITH q AS (SELECT plainto_tsquery('english', $2) AS query)
       SELECT s.id, s.artist, s.track, s.album, s.uri,
              us.play_count, us.stream_count, us.in_library,
              us.playlists::text AS playlists,
              l.body,
              ts_headline('english', l.body, q.query,
                          'StartSel=[[, StopSel=]], MaxWords=12, MinWords=5, MaxFragments=1')
                AS snippet
       FROM q, lyrics l
       JOIN songs s        ON s.id = l.song_id
       JOIN user_songs us  ON us.song_id = s.id AND us.user_id = $1
       WHERE l.body_tsv @@ q.query
       ORDER BY us.play_count DESC, s.artist, s.track`,
      [this.userId, words.join(" ")]
    );
    return rows;
  }

  async getSong(id) {
    // Joined through user_songs, so asking for a song you do not own is a 404
    // rather than a peek into someone else's library.
    const { rows } = await this.pool.query(
      `SELECT s.id, s.artist, s.track, s.album, s.uri,
              us.play_count, us.stream_count, us.ms_played, us.in_library,
              us.playlists::text AS playlists,
              l.status, l.body
       FROM user_songs us
       JOIN songs s      ON s.id = us.song_id
       LEFT JOIN lyrics l ON l.song_id = s.id
       WHERE us.user_id = $1 AND s.id = $2`,
      [this.userId, Number(id)]
    );
    return rows[0] || null;
  }

  async getSongsByIds(ids) {
    const { rows } = await this.pool.query(
      `SELECT s.id, s.artist, s.track, s.uri
       FROM user_songs us
       JOIN songs s ON s.id = us.song_id
       WHERE us.user_id = $1 AND s.id = ANY($2::bigint[])`,
      [this.userId, ids.map(Number)]
    );
    return rows;
  }

  async getStats() {
    // ::float8 on the sums: SUM() over int/bigint yields numeric, which
    // node-postgres also hands back as a string.
    const totals = await this.pool.query(
      `SELECT count(*)::int                  AS tracks,
              count(DISTINCT s.artist)::int  AS artists,
              COALESCE(sum(us.play_count), 0)::float8   AS plays,
              COALESCE(sum(us.stream_count), 0)::float8 AS streams,
              COALESCE(sum(us.ms_played), 0)::float8    AS ms
       FROM user_songs us JOIN songs s ON s.id = us.song_id
       WHERE us.user_id = $1`,
      [this.userId]
    );

    const topSongs = await this.pool.query(
      `SELECT s.id, s.artist, s.track, us.play_count, us.stream_count, us.ms_played
       FROM user_songs us JOIN songs s ON s.id = us.song_id
       WHERE us.user_id = $1 AND us.play_count > 0
       ORDER BY us.ms_played DESC LIMIT 25`,
      [this.userId]
    );

    const topArtists = await this.pool.query(
      `SELECT s.artist,
              count(*)::int                    AS songs,
              sum(us.play_count)::float8       AS plays,
              sum(us.stream_count)::float8     AS streams,
              sum(us.ms_played)::float8        AS ms
       FROM user_songs us JOIN songs s ON s.id = us.song_id
       WHERE us.user_id = $1
       GROUP BY s.artist HAVING sum(us.play_count) > 0
       ORDER BY ms DESC LIMIT 25`,
      [this.userId]
    );

    return { totals: totals.rows[0], topSongs: topSongs.rows, topArtists: topArtists.rows };
  }

  async getStatus() {
    const { rows } = await this.pool.query(
      `SELECT count(*)::int AS tracks FROM user_songs WHERE user_id = $1`,
      [this.userId]
    );
    return { tracks: rows[0].tracks, statuses: await this.getLyricStatusCounts() };
  }

  async getOkLyricCount() {
    const { rows } = await this.pool.query(
      `SELECT count(*)::int AS c
       FROM user_songs us JOIN lyrics l ON l.song_id = us.song_id
       WHERE us.user_id = $1 AND l.status = 'ok'`,
      [this.userId]
    );
    return rows[0].c;
  }

  async getOkLyricBodies() {
    const { rows } = await this.pool.query(
      `SELECT l.body, us.play_count
       FROM user_songs us JOIN lyrics l ON l.song_id = us.song_id
       WHERE us.user_id = $1 AND l.status = 'ok'`,
      [this.userId]
    );
    return rows;
  }

  // ── lyrics ────────────────────────────────────────────────────────────────

  async getSongsNeedingLyrics({ retryErrors = false } = {}) {
    // Scoped to this user, per the contract. The SaaS's background fetcher runs
    // a different, GLOBAL query — a song's lyrics are fetched once for everyone,
    // not once per user who owns it.
    const { rows } = await this.pool.query(
      `SELECT s.id, s.artist, s.track
       FROM user_songs us
       JOIN songs s       ON s.id = us.song_id
       LEFT JOIN lyrics l ON l.song_id = s.id
       WHERE us.user_id = $1
         AND (l.song_id IS NULL ${retryErrors ? "OR l.status = 'error'" : ""})
       ORDER BY us.play_count DESC`,
      [this.userId]
    );
    return rows;
  }

  async saveLyrics(songId, { status, source, body }) {
    // No index maintenance: lyrics.body_tsv is a GENERATED column, so Postgres
    // recomputes it from `body` on every write. The SQLite adapter has to
    // DELETE and re-INSERT its FTS row by hand; here it cannot fall out of sync.
    await this.pool.query(
      `INSERT INTO lyrics (song_id, status, source, body, fetched_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (song_id) DO UPDATE SET
         status     = EXCLUDED.status,
         source     = EXCLUDED.source,
         body       = EXCLUDED.body,
         fetched_at = EXCLUDED.fetched_at`,
      [Number(songId), status, source ?? null, body ?? null]
    );
  }

  async getLyricStatusCounts() {
    const { rows } = await this.pool.query(
      `SELECT l.status, count(*)::int AS count
       FROM user_songs us JOIN lyrics l ON l.song_id = us.song_id
       WHERE us.user_id = $1
       GROUP BY l.status`,
      [this.userId]
    );
    return rows;
  }

  // ── spotify auth ──────────────────────────────────────────────────────────

  async getAuth() {
    // spotify_user_id is aliased to user_id because that is what the contract
    // calls it — core.spotify.createPlaylist(token, row.user_id, ...) means the
    // SPOTIFY user, not our account id. SqliteAdapter's single-row `auth` table
    // has no such ambiguity; here the two ids coexist and must not be confused.
    const { rows } = await this.pool.query(
      `SELECT access_token, refresh_token, expires_at,
              spotify_user_id AS user_id, display_name
       FROM spotify_accounts WHERE user_id = $1`,
      [this.userId]
    );
    return rows[0] || null;
  }

  async saveTokens({ access_token, refresh_token, expires_at }) {
    await this.pool.query(
      `INSERT INTO spotify_accounts (user_id, access_token, refresh_token, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE SET
         access_token  = EXCLUDED.access_token,
         refresh_token = EXCLUDED.refresh_token,
         expires_at    = EXCLUDED.expires_at`,
      [this.userId, access_token ?? null, refresh_token ?? null, expires_at ?? null]
    );
  }

  async setAuthUser({ user_id, display_name }) {
    await this.pool.query(
      `UPDATE spotify_accounts SET spotify_user_id = $2, display_name = $3
       WHERE user_id = $1`,
      [this.userId, user_id ?? null, display_name ?? null]
    );
  }

  async clearAuth() {
    await this.pool.query("DELETE FROM spotify_accounts WHERE user_id = $1", [this.userId]);
  }

  async setSongUri(songId, uri) {
    // The URI lands on the GLOBAL song, so one user resolving it spares every
    // other user the lookup. Scoped by ownership so a user can only trigger this
    // for songs in their own library.
    await this.pool.query(
      `UPDATE songs SET uri = $3
       WHERE id = $2
         AND EXISTS (SELECT 1 FROM user_songs
                     WHERE user_id = $1 AND song_id = $2)`,
      [this.userId, Number(songId), uri]
    );
  }

  // ── dataset metadata ──────────────────────────────────────────────────────

  async getMeta() {
    const { rows } = await this.pool.query(
      "SELECT key, value FROM user_meta WHERE user_id = $1",
      [this.userId]
    );
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  async setMeta(entries) {
    const keys = Object.keys(entries);
    if (keys.length === 0) return;
    await this.pool.query(
      `INSERT INTO user_meta (user_id, key, value)
       SELECT $1, * FROM unnest($2::text[], $3::text[])
       ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [
        this.userId,
        keys,
        keys.map((k) => (entries[k] === null || entries[k] === undefined ? null : String(entries[k]))),
      ]
    );
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  async close() {
    // The pool is shared by the whole process and by every tenant's adapter, so
    // one user's request finishing must not tear it down. The host owns the
    // pool's lifetime; this is a no-op on purpose.
  }
}

module.exports = { PostgresAdapter };
