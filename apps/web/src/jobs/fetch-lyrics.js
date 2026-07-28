"use strict";

// Fill the global lyric catalogue from LRCLIB.
//
// GLOBAL, not per user. A song's words do not depend on who listened to it, so
// each one is fetched once and every user who owns it benefits. That is both the
// storage argument for the data model and — more importantly — what keeps our
// load on a free service flat as the user base grows: ten thousand users who all
// own the same top-40 song cost exactly one request.
//
// The politeness settings here are not tuning knobs, they are the terms on which
// LRCLIB stays usable. core/lyrics.js already backs off on 429/5xx; this adds a
// small fixed concurrency and a delay between requests.

const { fetchLyrics } = require("@lyricsearch/core/lyrics");
const { pendingSongs, saveLyrics } = require("../lyric-catalog");

const CONCURRENCY = 4;
const DELAY_MS = 250;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch lyrics for songs that have none, most-wanted first.
 *
 * @param {object} deps
 * @param {import("pg").Pool} deps.pool
 * @param {number} [deps.limit]        how many songs to attempt in this run
 * @param {number} [deps.concurrency]
 * @param {number} [deps.delayMs]
 * @param {boolean} [deps.retryErrors]
 * @param {(msg: string) => void} [deps.log]
 * @returns {Promise<{attempted:number, ok:number, notfound:number, instrumental:number, error:number}>}
 */
async function fetchPendingLyrics({
  pool,
  limit = 200,
  concurrency = CONCURRENCY,
  delayMs = DELAY_MS,
  retryErrors = false,
  log = () => {},
} = {}) {
  const pending = await pendingSongs(pool, { limit, retryErrors });
  const counts = { attempted: pending.length, ok: 0, notfound: 0, instrumental: 0, error: 0 };
  if (pending.length === 0) return counts;

  log(`fetching lyrics for ${pending.length} song(s)`);

  let index = 0;
  async function worker() {
    while (index < pending.length) {
      const song = pending[index++];
      let status;
      try {
        const result = await fetchLyrics(song.artist, song.track);
        await saveLyrics(pool, song.id, result);
        status = result.status;
      } catch (err) {
        // Recorded, not thrown. One song LRCLIB cannot answer for must not stop
        // the run, and the row is what makes a retry possible later
        // (retryErrors) instead of the miss being cached forever.
        await saveLyrics(pool, song.id, {
          status: "error",
          source: String(err.message || err).slice(0, 200),
          body: null,
        });
        status = "error";
      }
      counts[status]++;
      await sleep(delayMs);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker));

  log(
    `lyrics: ok=${counts.ok} notfound=${counts.notfound} ` +
      `instrumental=${counts.instrumental} error=${counts.error}`
  );
  return counts;
}

module.exports = { fetchPendingLyrics, CONCURRENCY, DELAY_MS };
