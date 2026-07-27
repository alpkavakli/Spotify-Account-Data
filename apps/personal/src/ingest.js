const path = require("node:path");
const fs = require("node:fs");
const { db } = require("./db");
const { buildSongs } = require("@lyricsearch/core/ingest");

const EXPORT_DIR = process.env.EXPORT_DIR
  ? path.resolve(process.env.EXPORT_DIR)
  : path.resolve(__dirname, "..", "Data");

function readJson(name) {
  const file = path.join(EXPORT_DIR, name);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// --- Read the export files (host concern: filesystem) ---
const library = readJson("YourLibrary.json");
const playlists = readJson("Playlist1.json");
const histories = [];
for (let i = 0; ; i++) {
  const hist = readJson(`StreamingHistory_music_${i}.json`);
  if (!hist) break;
  histories.push(hist);
}

// --- Merge into one row per song (pure core logic) ---
const { songs, stats } = buildSongs({ library, playlists, histories });
if (library?.tracks) console.log(`library: ${stats.libraryTracks} tracks`);
if (playlists?.playlists) {
  console.log(`playlists: ${stats.playlistLists} lists, ${stats.playlistItems} items`);
}
console.log(`history: ${stats.plays} plays`);

// --- Write to db (host concern: persistence; one transaction — Atomicity) ---
const stmt = db.prepare(`
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

db.exec("BEGIN");
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
db.exec("COMMIT");

const total = db.prepare("SELECT COUNT(*) c FROM tracks").get().c;
console.log(`done: ${songs.length} unique songs ingested, ${total} rows in db`);
