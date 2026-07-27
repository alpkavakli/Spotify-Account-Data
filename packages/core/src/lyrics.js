"use strict";

// LRCLIB lyrics client: search with backoff, pick the best match, classify the
// result. Network I/O lives here (this is the "lyrics source" concern); the host
// owns concurrency, politeness delays, and persistence.

const { normalize, cleanTitle } = require("./matching");

const API = "https://lrclib.net/api";
const HEADERS = {
  "User-Agent": "spotify-lyrics-search (personal project)",
};
const MAX_RETRIES = 4;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A 503/429 from lrclib means "backing off", not "no such song" — the first
 * bulk run recorded 3057 of them as permanent errors. Retry those with
 * exponential backoff so transient load doesn't get cached as a miss.
 * Throws on client errors and on exhausting retries.
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
  // Require one exact field, or a partial match on both. Deliberately looser
  // than spotify.pickMatch (>= 6, which demands a signal on both fields):
  // fetchLyrics retries with an artist-less search, and those results can never
  // match on artist. See test/lyrics.test.js "pickBest".
  return bestScore >= 4 ? best : null;
}

/**
 * Fetch and classify lyrics for one song. Returns a status record; does NOT
 * persist. Throws only on network/API failure (the host records that as "error").
 *
 * @returns {Promise<{status: "ok"|"notfound"|"instrumental", source: string|null, body: string|null}>}
 */
async function fetchLyrics(artist, track) {
  const title = cleanTitle(track);
  let results = await searchLrclib(artist, title);
  let best = pickBest(results, artist, title);
  // retry with title-only search; helps when artist spelling differs
  if (!best) {
    results = await searchLrclib("", title);
    best = pickBest(results, artist, title);
  }
  if (!best) return { status: "notfound", source: null, body: null };
  if (best.instrumental || !best.plainLyrics) {
    return { status: "instrumental", source: "lrclib", body: null };
  }
  return { status: "ok", source: "lrclib", body: best.plainLyrics };
}

module.exports = { searchLrclib, pickBest, fetchLyrics };
