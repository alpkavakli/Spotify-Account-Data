"use strict";

const path = require("node:path");
const fs = require("node:fs");
const store = require("./store");
const { buildSongs, DEFAULT_SKIP_THRESHOLD_MS } = require("@lyricsearch/core/ingest");

const EXPORT_DIR = process.env.EXPORT_DIR
  ? path.resolve(process.env.EXPORT_DIR)
  : path.resolve(__dirname, "..", "Data");

// How long a play has to last before it counts as listening rather than a skip.
// 30s is Spotify's own rule (what Wrapped calls a "stream"), but it is your
// data — set SKIP_THRESHOLD_SECONDS in .env to whatever you consider a real
// listen. Changing it and re-running ingest recomputes the counts; song ids and
// fetched lyrics are preserved.
const rawThreshold = process.env.SKIP_THRESHOLD_SECONDS;
const SKIP_THRESHOLD_MS =
  rawThreshold === undefined || rawThreshold === ""
    ? DEFAULT_SKIP_THRESHOLD_MS
    : Math.round(Number(rawThreshold) * 1000);

if (!Number.isFinite(SKIP_THRESHOLD_MS) || SKIP_THRESHOLD_MS < 0) {
  console.error(`SKIP_THRESHOLD_SECONDS must be a non-negative number, got: ${rawThreshold}`);
  process.exit(1);
}

// Spotify's two export packages name their history files differently, and a
// user may well have both (the small one now, the complete one a month later).
// Accept either. Streaming_History_Video_* is podcasts and stays out.
const HISTORY_PATTERNS = [
  /^StreamingHistory_music_\d+\.json$/i, // "Account data" — last 12 months only
  /^Streaming_History_Audio_.*\.json$/i, // "Extended streaming history" — everything
];

function readJson(name) {
  const file = path.join(EXPORT_DIR, name);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function historyFiles() {
  if (!fs.existsSync(EXPORT_DIR)) return [];
  return fs
    .readdirSync(EXPORT_DIR)
    .filter((f) => HISTORY_PATTERNS.some((re) => re.test(f)))
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
}

// --- Read the export files (host concern: filesystem) ---
const library = readJson("YourLibrary.json");
const playlists = readJson("Playlist1.json");

const files = historyFiles();
const histories = files.map((f) => readJson(f));
const hasExtended = files.some((f) => /^Streaming_History_Audio_/i.test(f));

// --- Merge into one row per song (pure core logic) ---
const { songs, stats } = buildSongs({
  library,
  playlists,
  histories,
  skipThresholdMs: SKIP_THRESHOLD_MS,
});

if (library?.tracks) console.log(`library: ${stats.libraryTracks} tracks`);
if (playlists?.playlists) {
  console.log(`playlists: ${stats.playlistLists} lists, ${stats.playlistItems} items`);
}

const thresholdSeconds = SKIP_THRESHOLD_MS / 1000;
console.log(
  `history: ${files.length} file(s), ${stats.historyRows} rows ` +
    (hasExtended ? "(extended streaming history)" : "(account data)")
);
console.log(
  `  ${stats.plays} plays · ${stats.streams} listens (${thresholdSeconds}s+) · ${stats.skips} skips`
);
if (stats.zeroMsRows) {
  console.log(`  ${stats.zeroMsRows} rows ignored (0 ms — queued but never started)`);
}
if (stats.unusableRows) {
  console.log(`  ${stats.unusableRows} rows ignored (podcasts / no track name)`);
}
if (stats.historyFrom) {
  console.log(`  covers ${stats.historyFrom} → ${stats.historyTo}`);
  if (!hasExtended) {
    console.log(
      '  note: the "Account data" export only contains the LAST 12 MONTHS.\n' +
        '        Request "Extended streaming history" for your full listening\n' +
        "        record — see Data/README.md."
    );
  }
}

async function main() {
  // --- Write to db (adapter owns the transaction — Atomicity) ---
  await store.upsertSongs(songs);

  // Record what this dataset actually is, so the UI can state the window the
  // numbers cover instead of implying they cover all time.
  await store.setMeta({
    history_from: stats.historyFrom,
    history_to: stats.historyTo,
    history_rows: stats.historyRows,
    history_source: hasExtended ? "extended" : "account-data",
    skip_threshold_ms: SKIP_THRESHOLD_MS,
    ingested_at: new Date().toISOString(),
  });

  const total = (await store.getStatus()).tracks;
  console.log(`done: ${songs.length} unique songs ingested, ${total} rows in db`);
}

main();
