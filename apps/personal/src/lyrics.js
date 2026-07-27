const store = require("./store");
const { fetchLyrics } = require("@lyricsearch/core/lyrics");

const CONCURRENCY = 4;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function processOne(row) {
  try {
    const { status, source, body } = await fetchLyrics(row.artist, row.track);
    await store.saveLyrics(row.id, { status, source, body });
    return status;
  } catch (err) {
    await store.saveLyrics(row.id, {
      status: "error",
      source: String(err.message || err).slice(0, 200),
      body: null,
    });
    return "error";
  }
}

async function main() {
  const retryErrors = process.argv.includes("--retry-errors");
  const pending = await store.getSongsNeedingLyrics({ retryErrors });

  if (pending.length === 0) {
    console.log("nothing to fetch — all tracks processed");
    await printStats();
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
  await printStats();
}

async function printStats() {
  const rows = await store.getLyricStatusCounts();
  console.log("lyrics status:", rows.map((r) => `${r.status}=${r.count}`).join("  "));
}

main();
