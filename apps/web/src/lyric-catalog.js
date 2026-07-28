"use strict";

// The GLOBAL lyric catalogue.
//
// Deliberately NOT a StorageAdapter. That contract is per-tenant, and fetching
// lyrics is the one operation in the system that has no tenant: a song's words
// are the same for everybody, so it is fetched ONCE and every user who owns that
// song benefits. Forcing this through a user-scoped adapter would either need a
// fake user or a "global mode" flag — both of which would make it possible to
// call a genuinely per-user method without a user.
//
// This is the mechanism behind the promise in PROJECT_PLAN.md §7: LRCLIB is
// asked about each song exactly once no matter how large the user base grows.

/**
 * Songs that nobody has lyrics for yet, most-wanted first.
 *
 * Ordered by how many users own the song: with a backlog, the fetch that
 * unblocks the most people happens first. play_count breaks ties so a song one
 * person has on repeat still beats one nobody has played.
 *
 * @param {import("pg").Pool} pool
 * @param {{limit?: number, retryErrors?: boolean}} [opts]
 */
async function pendingSongs(pool, { limit = 200, retryErrors = false } = {}) {
  const { rows } = await pool.query(
    `SELECT s.id, s.artist, s.track,
            count(us.user_id)::int      AS owners,
            COALESCE(sum(us.play_count), 0)::float8 AS plays
     FROM songs s
     LEFT JOIN lyrics l     ON l.song_id = s.id
     LEFT JOIN user_songs us ON us.song_id = s.id
     WHERE l.song_id IS NULL ${retryErrors ? "OR l.status = 'error'" : ""}
     GROUP BY s.id
     ORDER BY owners DESC, plays DESC, s.id
     LIMIT $1`,
    [limit]
  );
  return rows;
}

/**
 * Store a lyric result globally.
 *
 * No search-index maintenance: lyrics.body_tsv is a GENERATED column, so
 * Postgres recomputes it from `body` on every write and it cannot drift.
 */
async function saveLyrics(pool, songId, { status, source, body }) {
  await pool.query(
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

/** How the catalogue as a whole is doing — for /health, logs and dashboards. */
async function catalogueStats(pool) {
  const { rows } = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM songs) AS songs,
       (SELECT count(*)::int FROM lyrics) AS processed,
       (SELECT count(*)::int FROM lyrics WHERE status = 'ok') AS ok,
       (SELECT count(*)::int FROM lyrics WHERE status = 'notfound') AS notfound,
       (SELECT count(*)::int FROM lyrics WHERE status = 'instrumental') AS instrumental,
       (SELECT count(*)::int FROM lyrics WHERE status = 'error') AS error`
  );
  const s = rows[0];
  return { ...s, pending: s.songs - s.processed };
}

module.exports = { pendingSongs, saveLyrics, catalogueStats };
