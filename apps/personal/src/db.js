const path = require("node:path");
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(__dirname, "..", "Data");

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, "spotify.db"));

db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
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
db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS lyrics_fts USING fts5(
    body,
    content = 'lyrics',
    content_rowid = 'track_id',
    tokenize = 'porter unicode61'
  );
`);

module.exports = { db, DATA_DIR };
