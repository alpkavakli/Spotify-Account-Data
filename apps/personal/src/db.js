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

/**
 * Collapses "Artist" + "Track" into a single stable identity key.
 *
 * Spotify spells the same song differently across exports (the library says
 * "Love Will Tear Us Apart - 2020 Remaster", the history says "Love Will Tear
 * Us Apart"), so the key is built from the cleaned title to keep those from
 * landing as two separate rows.
 */
function matchKey(artist, track) {
  return `${normalize(artist)}|||${normalize(cleanTitle(track))}`;
}

function normalize(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Strips the version cruft Spotify appends, which lyrics providers don't know about. */
function cleanTitle(title) {
  return String(title || "")
    .replace(/\s*[-–]\s*(\d{4}\s*)?(remaster(ed)?|remix|radio edit|single version|album version|mono|stereo|live|acoustic|instrumental|sped up|slowed)\b.*$/i, "")
    .replace(/\s*[\(\[][^)\]]*(remaster(ed)?|remix|radio edit|single version|album version|version|sped up|slowed|reverb|live|acoustic|bonus|feat\.?|ft\.?|with)\b[^)\]]*[\)\]]/gi, "")
    .replace(/\s+/g, " ")
    .trim() || String(title || "").trim();
}

module.exports = { db, DATA_DIR, matchKey, normalize, cleanTitle };
