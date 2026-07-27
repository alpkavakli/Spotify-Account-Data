const path = require("node:path");
const fs = require("node:fs");
const store = require("./store");
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

async function main() {
  // --- Write to db (adapter owns the transaction — Atomicity) ---
  await store.upsertSongs(songs);

  const total = (await store.getStatus()).tracks;
  console.log(`done: ${songs.length} unique songs ingested, ${total} rows in db`);
}

main();
