const { db } = require("./db");
const { fetchLyrics } = require("@lyricsearch/core/lyrics");

const CONCURRENCY = 4;

const insertLyrics = db.prepare(`
  INSERT INTO lyrics (track_id, status, source, body, fetched_at)
  VALUES (?, ?, ?, ?, datetime('now'))
  ON CONFLICT(track_id) DO UPDATE SET
    status = excluded.status,
    source = excluded.source,
    body = excluded.body,
    fetched_at = excluded.fetched_at
`);
const insertFts = db.prepare(
  "INSERT INTO lyrics_fts (rowid, body) VALUES (?, ?)"
);
const deleteFts = db.prepare("DELETE FROM lyrics_fts WHERE rowid = ?");

function saveLyrics(trackId, status, source, body) {
  deleteFts.run(trackId);
  insertLyrics.run(trackId, status, source, body);
  if (status === "ok" && body) insertFts.run(trackId, body);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function processOne(row) {
  try {
    const { status, source, body } = await fetchLyrics(row.artist, row.track);
    saveLyrics(row.id, status, source, body);
    return status;
  } catch (err) {
    saveLyrics(row.id, "error", String(err.message || err).slice(0, 200), null);
    return "error";
  }
}

async function main() {
  const retryErrors = process.argv.includes("--retry-errors");
  const pending = db
    .prepare(
      `SELECT t.id, t.artist, t.track FROM tracks t
       LEFT JOIN lyrics l ON l.track_id = t.id
       WHERE l.track_id IS NULL ${retryErrors ? "OR l.status = 'error'" : ""}
       ORDER BY t.play_count DESC`
    )
    .all();

  if (pending.length === 0) {
    console.log("nothing to fetch — all tracks processed");
    printStats();
    return;
  }
  console.log(`fetching lyrics for ${pending.length} tracks...`);

  const counts = { ok: 0, notfound: 0, instrumental: 0, error: 0 };
  let done = 0;
  let idx = 0;

  async function worker() {
    while (idx < pending.length) {
      const row = pending[idx++];
      const result = await processOne(row);
      counts[result]++;
      done++;
      if (done % 50 === 0 || done === pending.length) {
        console.log(
          `${done}/${pending.length}  ok:${counts.ok} notfound:${counts.notfound} instrumental:${counts.instrumental} error:${counts.error}`
        );
      }
      // stay polite to the free API
      await sleep(250);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log("done.");
  printStats();
}

function printStats() {
  const rows = db
    .prepare("SELECT status, COUNT(*) c FROM lyrics GROUP BY status")
    .all();
  console.log("lyrics status:", rows.map((r) => `${r.status}=${r.c}`).join("  "));
}

main();
