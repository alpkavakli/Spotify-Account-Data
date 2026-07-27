const { db, normalize, cleanTitle } = require("./db");

const API = "https://lrclib.net/api";
const HEADERS = {
  "User-Agent": "spotify-lyrics-search (personal project)",
};
const CONCURRENCY = 4;
const MAX_RETRIES = 4;

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

/**
 * A 503/429 from lrclib means "backing off", not "no such song" — the first
 * bulk run recorded 3057 of them as permanent errors. Retry those with
 * exponential backoff so transient load doesn't get cached as a miss.
 */
async function searchLrclib(artist, title) {
  const url = new URL(API + "/search");
  url.searchParams.set("track_name", title);
  url.searchParams.set("artist_name", artist);

  let lastStatus = 0;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(500 * 2 ** (attempt - 1) + Math.random() * 250);

    let res;
    try {
      res = await fetch(url, { headers: HEADERS });
    } catch (err) {
      lastStatus = 0;
      continue; // network blip — retry
    }

    if (res.status === 404) return [];
    if (res.ok) return res.json();

    lastStatus = res.status;
    if (res.status !== 429 && res.status < 500) {
      throw new Error(`lrclib ${res.status}`); // client error — retrying won't help
    }
  }
  throw new Error(`lrclib ${lastStatus || "fetch failed"} after ${MAX_RETRIES} retries`);
}

function pickBest(results, artist, title) {
  const wantArtist = normalize(artist);
  const wantTitle = normalize(title);
  let best = null;
  let bestScore = -1;
  for (const r of results) {
    const a = normalize(r.artistName);
    const t = normalize(r.trackName);
    let score = 0;
    if (a === wantArtist) score += 4;
    else if (a.includes(wantArtist) || wantArtist.includes(a)) score += 2;
    if (t === wantTitle) score += 4;
    else if (t.includes(wantTitle) || wantTitle.includes(t)) score += 2;
    if (r.plainLyrics) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  // require at least a partial match on both fields
  return bestScore >= 4 ? best : null;
}

async function fetchOne(row) {
  const title = cleanTitle(row.track);
  try {
    let results = await searchLrclib(row.artist, title);
    let best = pickBest(results, row.artist, title);
    // retry with title-only search; helps when artist spelling differs
    if (!best) {
      results = await searchLrclib("", title);
      best = pickBest(results, row.artist, title);
    }
    if (!best) {
      saveLyrics(row.id, "notfound", null, null);
      return "notfound";
    }
    if (best.instrumental || !best.plainLyrics) {
      saveLyrics(row.id, "instrumental", "lrclib", null);
      return "instrumental";
    }
    saveLyrics(row.id, "ok", "lrclib", best.plainLyrics);
    return "ok";
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
      const result = await fetchOne(row);
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
