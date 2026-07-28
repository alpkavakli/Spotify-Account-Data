"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const { StorageAdapter } = require("@lyricsearch/core/storage");

// SQLite implementation of the StorageAdapter contract — the Personal Edition's
// single-user store. All SQL lives here; nothing else in apps/personal touches
// the database directly.
//
// The methods are `async` to satisfy the contract, but node:sqlite is synchronous
// so the work happens inline and the promise is already resolved when it returns.
// There is no thread hop and no added latency — only the shape callers need in
// order to be able to hold a PostgresAdapter instead.
class SqliteAdapter extends StorageAdapter {
  /**
   * @param {string} dataDir  directory holding spotify.db
   * @param {{readOnly?: boolean}} [opts]
   */
  constructor(dataDir, { readOnly = false } = {}) {
    super();
    this.dataDir = path.resolve(dataDir);
    if (!readOnly) fs.mkdirSync(this.dataDir, { recursive: true });

    this.db = new DatabaseSync(path.join(this.dataDir, "spotify.db"), { readOnly });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    if (!readOnly) this.#ensureSchema();
  }

  #ensureSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tracks (
        id          INTEGER PRIMARY KEY,
        match_key   TEXT NOT NULL UNIQUE,
        artist      TEXT NOT NULL,
        track       TEXT NOT NULL,
        album       TEXT,
        uri         TEXT,
        in_library  INTEGER NOT NULL DEFAULT 0,
        play_count  INTEGER NOT NULL DEFAULT 0,
        stream_count INTEGER NOT NULL DEFAULT 0,
        ms_played   INTEGER NOT NULL DEFAULT 0,
        playlists   TEXT NOT NULL DEFAULT '[]'
      );

      CREATE TABLE IF NOT EXISTS lyrics (
        track_id    INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
        status      TEXT NOT NULL,
        source      TEXT,
        body        TEXT,
        fetched_at  TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_lyrics_status ON lyrics(status);
      CREATE INDEX IF NOT EXISTS idx_tracks_plays  ON tracks(play_count DESC);
    `);

    // Porter stemming is what makes a search for "door" also hit "doors".
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS lyrics_fts USING fts5(
        body,
        content = 'lyrics',
        content_rowid = 'track_id',
        tokenize = 'porter unicode61'
      );
    `);

    // Facts about the ingested export itself (history coverage window, the skip
    // threshold that produced the counts, ingest time) — see StorageAdapter.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS auth (
        id            INTEGER PRIMARY KEY CHECK (id = 1),
        access_token  TEXT,
        refresh_token TEXT,
        expires_at    INTEGER,
        user_id       TEXT,
        display_name  TEXT
      );
    `);

    this.#migrate();
  }

  // Forward-only migrations for databases created by an earlier version.
  // CREATE TABLE IF NOT EXISTS does nothing to a table that already exists, so
  // a column added later has to be applied explicitly or existing users get
  // "no such column" on the next query.
  #migrate() {
    const columns = this.db
      .prepare("PRAGMA table_info(tracks)")
      .all()
      .map((c) => c.name);

    if (!columns.includes("stream_count")) {
      // Existing rows get 0 until the next `npm run ingest` recomputes them from
      // the export. Defaulting to play_count would be a lie: we cannot know how
      // many of those plays passed the skip threshold without re-reading the
      // history files.
      this.db.exec("ALTER TABLE tracks ADD COLUMN stream_count INTEGER NOT NULL DEFAULT 0");
    }
  }

  // ── ingest ──
  async upsertSongs(songs) {
    const stmt = this.db.prepare(`
      INSERT INTO tracks (match_key, artist, track, album, uri, in_library, play_count, stream_count, ms_played, playlists)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(match_key) DO UPDATE SET
        album        = COALESCE(tracks.album, excluded.album),
        uri          = COALESCE(tracks.uri, excluded.uri),
        in_library   = MAX(tracks.in_library, excluded.in_library),
        play_count   = excluded.play_count,
        stream_count = excluded.stream_count,
        ms_played    = excluded.ms_played,
        playlists    = excluded.playlists
    `);
    this.db.exec("BEGIN");
    try {
      for (const s of songs) {
        stmt.run(
          s.match_key,
          s.artist,
          s.track,
          s.album,
          s.uri,
          s.in_library,
          s.play_count,
          s.stream_count || 0,
          s.ms_played,
          JSON.stringify(s.playlists)
        );
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return { inserted: songs.length };
  }

  // ── search & read ──
  async searchByLyrics(ftsQuery) {
    return this.db
      .prepare(
        `SELECT t.id, t.artist, t.track, t.album, t.uri, t.play_count, t.stream_count,
                t.in_library, t.playlists, l.body,
                snippet(lyrics_fts, 0, '[[', ']]', ' … ', 12) AS snippet
         FROM lyrics_fts
         JOIN tracks t ON t.id = lyrics_fts.rowid
         JOIN lyrics l ON l.track_id = t.id
         WHERE lyrics_fts MATCH ?
         ORDER BY t.play_count DESC, t.artist, t.track`
      )
      .all(ftsQuery);
  }

  async getSong(id) {
    return (
      this.db
        .prepare(
          `SELECT t.id, t.artist, t.track, t.album, t.uri, t.play_count, t.stream_count,
                  t.ms_played, t.in_library, t.playlists, l.status, l.body
           FROM tracks t LEFT JOIN lyrics l ON l.track_id = t.id
           WHERE t.id = ?`
        )
        .get(Number(id)) || null
    );
  }

  async getSongsByIds(ids) {
    const placeholders = ids.map(() => "?").join(",");
    return this.db
      .prepare(`SELECT id, artist, track, uri FROM tracks WHERE id IN (${placeholders})`)
      .all(...ids.map(Number));
  }

  async getStats() {
    const totals = this.db
      .prepare(
        `SELECT COUNT(*) tracks, COUNT(DISTINCT artist) artists,
                SUM(play_count) plays, SUM(stream_count) streams,
                SUM(ms_played) ms FROM tracks`
      )
      .get();
    const topSongs = this.db
      .prepare(
        `SELECT id, artist, track, play_count, stream_count, ms_played FROM tracks
         WHERE play_count > 0 ORDER BY ms_played DESC LIMIT 25`
      )
      .all();
    const topArtists = this.db
      .prepare(
        `SELECT artist, COUNT(*) songs, SUM(play_count) plays,
                SUM(stream_count) streams, SUM(ms_played) ms
         FROM tracks GROUP BY artist HAVING plays > 0
         ORDER BY ms DESC LIMIT 25`
      )
      .all();
    return { totals, topSongs, topArtists };
  }

  async getStatus() {
    const tracks = this.db.prepare("SELECT COUNT(*) c FROM tracks").get().c;
    const statuses = this.db
      .prepare("SELECT status, COUNT(*) c FROM lyrics GROUP BY status")
      .all()
      .map((r) => ({ status: r.status, count: r.c }));
    return { tracks, statuses };
  }

  async getOkLyricCount() {
    return this.db
      .prepare("SELECT COUNT(*) c FROM lyrics WHERE status = 'ok'")
      .get().c;
  }

  async getOkLyricBodies() {
    return this.db
      .prepare(
        `SELECT l.body, t.play_count FROM lyrics l
         JOIN tracks t ON t.id = l.track_id WHERE l.status = 'ok'`
      )
      .all();
  }

  // ── lyrics ──
  async getSongsNeedingLyrics({ retryErrors = false } = {}) {
    return this.db
      .prepare(
        `SELECT t.id, t.artist, t.track FROM tracks t
         LEFT JOIN lyrics l ON l.track_id = t.id
         WHERE l.track_id IS NULL ${retryErrors ? "OR l.status = 'error'" : ""}
         ORDER BY t.play_count DESC`
      )
      .all();
  }

  async saveLyrics(songId, { status, source, body }) {
    this.db.prepare("DELETE FROM lyrics_fts WHERE rowid = ?").run(songId);
    this.db
      .prepare(
        `INSERT INTO lyrics (track_id, status, source, body, fetched_at)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(track_id) DO UPDATE SET
           status = excluded.status,
           source = excluded.source,
           body = excluded.body,
           fetched_at = excluded.fetched_at`
      )
      .run(songId, status, source, body);
    if (status === "ok" && body) {
      this.db.prepare("INSERT INTO lyrics_fts (rowid, body) VALUES (?, ?)").run(songId, body);
    }
  }

  async getLyricStatusCounts() {
    return this.db
      .prepare("SELECT status, COUNT(*) c FROM lyrics GROUP BY status")
      .all()
      .map((r) => ({ status: r.status, count: r.c }));
  }

  // ── spotify auth ──
  async getAuth() {
    return this.db.prepare("SELECT * FROM auth WHERE id = 1").get() || null;
  }

  async saveTokens({ access_token, refresh_token, expires_at }) {
    this.db
      .prepare(
        `INSERT INTO auth (id, access_token, refresh_token, expires_at)
         VALUES (1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           access_token = excluded.access_token,
           refresh_token = excluded.refresh_token,
           expires_at = excluded.expires_at`
      )
      .run(access_token, refresh_token, expires_at);
  }

  async setAuthUser({ user_id, display_name }) {
    this.db
      .prepare("UPDATE auth SET user_id = ?, display_name = ? WHERE id = 1")
      .run(user_id, display_name);
  }

  async clearAuth() {
    this.db.prepare("DELETE FROM auth WHERE id = 1").run();
  }

  async setSongUri(songId, uri) {
    this.db.prepare("UPDATE tracks SET uri = ? WHERE id = ?").run(uri, songId);
  }

  // ── dataset metadata ──
  async getMeta() {
    const rows = this.db.prepare("SELECT key, value FROM meta").all();
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  async setMeta(entries) {
    const stmt = this.db.prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    );
    this.db.exec("BEGIN");
    try {
      for (const [key, value] of Object.entries(entries)) {
        stmt.run(key, value === null || value === undefined ? null : String(value));
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  // ── lifecycle ──
  async close() {
    this.db.close();
  }
}

module.exports = { SqliteAdapter };
