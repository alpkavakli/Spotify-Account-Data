"use strict";

// The background worker: a separate process from the API.
//
// Separate on purpose (docs/02-SCALABILITY.md). Parsing a 20k-row export and
// walking a lyric backlog are minutes of work; doing them in the web process
// would make request latency depend on how many people happened to upload
// something. Splitting them also means each can be scaled — or restarted —
// without touching the other.
//
//   node src/worker.js        alongside `npm start`

const path = require("node:path");
const { Pool } = require("pg");
const { PgBoss } = require("pg-boss");

const { databaseUrl } = require("./config");
const { LocalBlobStore } = require("./blob-store");
const { parseUpload } = require("./jobs/parse-upload");
const { fetchPendingLyrics } = require("./jobs/fetch-lyrics");
const { catalogueStats } = require("./lyric-catalog");
const { purgeExpired } = require("./auth");
const { QUEUE_PARSE_UPLOAD, QUEUE_FETCH_LYRICS } = require("./queue");

const BLOB_DIR = process.env.BLOB_DIR || path.join(__dirname, "..", "blobs");
const LYRIC_BATCH = Number(process.env.LYRIC_BATCH || 200);

async function main() {
  const connectionString = databaseUrl();
  const pool = new Pool({ connectionString });
  const blobStore = new LocalBlobStore(BLOB_DIR);

  const boss = new PgBoss({ connectionString });
  boss.on("error", (err) => console.error("pg-boss:", err.message));
  await boss.start();

  await boss.createQueue(QUEUE_PARSE_UPLOAD);
  await boss.createQueue(QUEUE_FETCH_LYRICS);

  // ── parse an upload ──────────────────────────────────────────────────────
  await boss.work(QUEUE_PARSE_UPLOAD, { batchSize: 1 }, async ([job]) => {
    const { uploadId } = job.data;
    console.log(`parse-upload #${uploadId}`);
    const result = await parseUpload({ pool, blobStore, uploadId });
    console.log(`parse-upload #${uploadId}: ${result.status}${result.songs ? ` (${result.songs} songs)` : ""}`);

    // New songs almost certainly need lyrics. One sweep, collapsed by
    // singletonKey however many uploads land at once.
    if (result.status === "done") {
      await boss.send(QUEUE_FETCH_LYRICS, {}, { singletonKey: QUEUE_FETCH_LYRICS, singletonHours: 1 });
    }
  });

  // ── fill the global lyric catalogue ──────────────────────────────────────
  await boss.work(
    QUEUE_FETCH_LYRICS,
    // One at a time, process-wide. Several concurrent sweeps would multiply our
    // request rate against a free service that has been generous to us.
    { batchSize: 1 },
    async () => {
      const counts = await fetchPendingLyrics({ pool, limit: LYRIC_BATCH, log: console.log });
      const stats = await catalogueStats(pool);
      console.log(`catalogue: ${stats.processed}/${stats.songs} songs processed, ${stats.pending} pending`);

      // More left than this batch handled? Queue the next pass rather than
      // running until the backlog is gone, so a restart never loses much and
      // one huge upload cannot monopolise the worker.
      if (stats.pending > 0 && counts.attempted > 0) {
        await boss.send(QUEUE_FETCH_LYRICS, {}, { startAfter: 5 });
      }
    }
  );

  // A safety net: even with nothing being uploaded, sweep for stragglers —
  // songs whose fetch failed, or that arrived while the worker was down.
  await boss.schedule(QUEUE_FETCH_LYRICS, "*/15 * * * *");

  const purge = setInterval(() => {
    purgeExpired(pool).catch((err) => console.error("purge failed:", err.message));
  }, 60 * 60 * 1000);
  purge.unref();

  console.log("worker started");
  console.log(`  blobs:       ${BLOB_DIR}`);
  console.log(`  lyric batch: ${LYRIC_BATCH}`);
  console.log(`  catalogue:   ${JSON.stringify(await catalogueStats(pool))}`);

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, async () => {
      console.log("shutting down…");
      await boss.stop({ graceful: true }).catch(() => {});
      await pool.end().catch(() => {});
      process.exit(0);
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
