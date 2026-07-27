"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const { StorageAdapter } = require("@lyricsearch/core/storage");

// SQLite implementation of the StorageAdapter contract — the Personal Edition's
// single-user store. All SQL lives here; nothing else in apps/personal touches
// the database directly.
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
  }

  // ── ingest ──
  upsertSongs(songs) {
    const stmt = this.db.prepare(`
      INSERT INTO tracks (match_key, artist, track, album, uri, in_library, play_count, ms_played, playlists)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(match_key) DO UPDATE SET
        album      = COALESCE(tracks.album, excluded.album),
        uri        = COALESCE(tracks.uri, excluded.uri),
        in_library = MAX(tracks.in_library, excluded.in_library),
        play_count = excluded.play_count,
        ms_played  = excluded.ms_played,
        playlists  = excluded.playlists
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
  searchByLyrics(ftsQuery) {
    return this.db
      .prepare(
        `SELECT t.id, t.artist, t.track, t.album, t.uri, t.play_count, t.in_library, t.playlists,
                l.body,
                snippet(lyrics_fts, 0, '[[', ']]', ' … ', 12) AS snippet
         FROM lyrics_fts
         JOIN tracks t ON t.id = lyrics_fts.rowid
         JOIN lyrics l ON l.track_id = t.id
         WHERE lyrics_fts MATCH ?
         ORDER BY t.play_count DESC, t.artist, t.track`
      )
      .all(ftsQuery);
  }

  getSong(id) {
    return (
      this.db
        .prepare(
          `SELECT t.id, t.artist, t.track, t.album, t.uri, t.play_count, t.ms_played,
                  t.in_library, t.playlists, l.status, l.body
           FROM tracks t LEFT JOIN lyrics l ON l.track_id = t.id
           WHERE t.id = ?`
        )
        .get(Number(id)) || null
    );
  }

  getSongsByIds(ids) {
    const placeholders = ids.map(() => "?").join(",");
    return this.db
      .prepare(`SELECT id, artist, track, uri FROM tracks WHERE id IN (${placeholders})`)
      .all(...ids.map(Number));
  }

  getStats() {
    const totals = this.db
      .prepare(
        `SELECT COUNT(*) tracks, COUNT(DISTINCT artist) artists,
                SUM(play_count) plays, SUM(ms_played) ms FROM tracks`
      )
      .get();
    const topSongs = this.db
      .prepare(
        `SELECT id, artist, track, play_count, ms_played FROM tracks
         WHERE play_count > 0 ORDER BY ms_played DESC LIMIT 25`
      )
      .all();
    const topArtists = this.db
      .prepare(
        `SELECT artist, COUNT(*) songs, SUM(play_count) plays, SUM(ms_played) ms
         FROM tracks GROUP BY artist HAVING plays > 0
         ORDER BY ms DESC LIMIT 25`
      )
      .all();
    return { totals, topSongs, topArtists };
  }

  getStatus() {
    const tracks = this.db.prepare("SELECT COUNT(*) c FROM tracks").get().c;
    const statuses = this.db
      .prepare("SELECT status, COUNT(*) c FROM lyrics GROUP BY status")
      .all()
      .map((r) => ({ status: r.status, count: r.c }));
    return { tracks, statuses };
  }

  getOkLyricCount() {
    return this.db
      .prepare("SELECT COUNT(*) c FROM lyrics WHERE status = 'ok'")
      .get().c;
  }

  getOkLyricBodies() {
    return this.db
      .prepare(
        `SELECT l.body, t.play_count FROM lyrics l
         JOIN tracks t ON t.id = l.track_id WHERE l.status = 'ok'`
      )
      .all();
  }

  // ── lyrics ──
  getSongsNeedingLyrics({ retryErrors = false } = {}) {
    return this.db
      .prepare(
        `SELECT t.id, t.artist, t.track FROM tracks t
         LEFT JOIN lyrics l ON l.track_id = t.id
         WHERE l.track_id IS NULL ${retryErrors ? "OR l.status = 'error'" : ""}
         ORDER BY t.play_count DESC`
      )
      .all();
  }

  saveLyrics(songId, { status, source, body }) {
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

  getLyricStatusCounts() {
    return this.db
      .prepare("SELECT status, COUNT(*) c FROM lyrics GROUP BY status")
      .all()
      .map((r) => ({ status: r.status, count: r.c }));
  }

  // ── spotify auth ──
  getAuth() {
    return this.db.prepare("SELECT * FROM auth WHERE id = 1").get() || null;
  }

  saveTokens({ access_token, refresh_token, expires_at }) {
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

  setAuthUser({ user_id, display_name }) {
    this.db
      .prepare("UPDATE auth SET user_id = ?, display_name = ? WHERE id = 1")
      .run(user_id, display_name);
  }

  clearAuth() {
    this.db.prepare("DELETE FROM auth WHERE id = 1").run();
  }

  setSongUri(songId, uri) {
    this.db.prepare("UPDATE tracks SET uri = ? WHERE id = ?").run(uri, songId);
  }

  // ── lifecycle ──
  close() {
    this.db.close();
  }
}

module.exports = { SqliteAdapter };
