const path = require("node:path");
const fs = require("node:fs");
const { db, matchKey } = require("./db");

const EXPORT_DIR = process.env.EXPORT_DIR
  ? path.resolve(process.env.EXPORT_DIR)
  : path.resolve(__dirname, "..", "..", "Data");

function readJson(name) {
  const file = path.join(EXPORT_DIR, name);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// key -> { artist, track, album, uri, in_library, play_count, ms_played, playlists:Set }
const songs = new Map();

function upsert(artist, track, extra = {}) {
  if (!artist || !track) return null;
  const key = matchKey(artist, track);
  let row = songs.get(key);
  if (!row) {
    row = {
      artist,
      track,
      album: null,
      uri: null,
      in_library: 0,
      play_count: 0,
      ms_played: 0,
      playlists: new Set(),
    };
    songs.set(key, row);
  }
  if (extra.album && !row.album) row.album = extra.album;
  if (extra.uri && !row.uri) row.uri = extra.uri;
  if (extra.in_library) row.in_library = 1;
  if (extra.playlist) row.playlists.add(extra.playlist);
  if (extra.ms_played) {
    row.play_count += 1;
    row.ms_played += extra.ms_played;
  }
  return row;
}

// --- Library ---
const lib = readJson("YourLibrary.json");
if (lib?.tracks) {
  for (const t of lib.tracks) {
    upsert(t.artist, t.track, { album: t.album, uri: t.uri, in_library: 1 });
  }
  console.log(`library: ${lib.tracks.length} tracks`);
}

// --- Playlists ---
const pl = readJson("Playlist1.json");
if (pl?.playlists) {
  let n = 0;
  for (const p of pl.playlists) {
    for (const item of p.items || []) {
      const t = item.track;
      if (!t?.trackName) continue;
      n++;
      upsert(t.artistName, t.trackName, {
        album: t.albumName,
        uri: t.trackUri,
        playlist: p.name,
      });
    }
  }
  console.log(`playlists: ${pl.playlists.length} lists, ${n} items`);
}

// --- Streaming history ---
let plays = 0;
for (let i = 0; ; i++) {
  const hist = readJson(`StreamingHistory_music_${i}.json`);
  if (!hist) break;
  for (const h of hist) {
    plays++;
    upsert(h.artistName, h.trackName, { ms_played: h.msPlayed });
  }
}
console.log(`history: ${plays} plays`);

// --- Write to db ---
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
for (const [key, r] of songs) {
  stmt.run(
    key,
    r.artist,
    r.track,
    r.album,
    r.uri,
    r.in_library,
    r.play_count,
    r.ms_played,
    JSON.stringify([...r.playlists])
  );
}
db.exec("COMMIT");

const total = db.prepare("SELECT COUNT(*) c FROM tracks").get().c;
console.log(`done: ${songs.size} unique songs ingested, ${total} rows in db`);
