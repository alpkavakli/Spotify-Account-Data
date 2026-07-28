"use strict";

// Turn an uploaded export into a user's library.
//
// A plain async function taking its dependencies, not a pg-boss handler —
// worker.js does the queue wiring. That keeps this testable without a queue,
// and keeps the queue swappable (BullMQ later) without touching the work.
//
// This is why POST /uploads answers 202: a real export is 20k+ history rows
// across several files, and no HTTP request should be held open for it.

const { buildSongs, DEFAULT_SKIP_THRESHOLD_MS } = require("@lyricsearch/core/ingest");
const { readSpotifyExport } = require("@lyricsearch/core/zip");
const { PostgresAdapter } = require("../postgres-adapter");

/**
 * @param {object} deps
 * @param {import("pg").Pool} deps.pool
 * @param {import("../blob-store").BlobStore} deps.blobStore
 * @param {number} deps.uploadId
 * @param {number} [deps.skipThresholdMs]
 * @returns {Promise<{status: string, songs?: number, error?: string}>}
 */
async function parseUpload({ pool, blobStore, uploadId, skipThresholdMs = DEFAULT_SKIP_THRESHOLD_MS }) {
  // Claim the row. The WHERE on status is what makes a double-delivered job
  // harmless: at-least-once is the only delivery guarantee a queue can give, so
  // the second attempt must find nothing to claim rather than ingest twice.
  const claim = await pool.query(
    `UPDATE uploads SET status = 'processing'
     WHERE id = $1 AND status = 'pending'
     RETURNING user_id, blob_key`,
    [uploadId]
  );
  if (claim.rows.length === 0) {
    return { status: "skipped" };
  }

  const { user_id: userId, blob_key: blobKey } = claim.rows[0];

  try {
    const buffer = await blobStore.get(blobKey);
    const exported = readSpotifyExport(buffer);

    if (!exported.library && !exported.playlists && exported.histories.length === 0) {
      throw new Error(
        "no Spotify data found in that file — expected YourLibrary.json, " +
          "Playlist1.json or streaming history files"
      );
    }

    const { songs, stats } = buildSongs({
      library: exported.library,
      playlists: exported.playlists,
      histories: exported.histories,
      skipThresholdMs,
    });

    const store = new PostgresAdapter(pool, { userId });
    await store.upsertSongs(songs);

    // Record what this dataset actually covers, so the UI can say so instead of
    // implying the numbers are all-time. Spotify's standard export is 12 months.
    await store.setMeta({
      history_from: stats.historyFrom,
      history_to: stats.historyTo,
      history_rows: stats.historyRows,
      history_source: exported.hasExtendedHistory ? "extended" : "account-data",
      skip_threshold_ms: skipThresholdMs,
      ingested_at: new Date().toISOString(),
    });

    await pool.query(
      `UPDATE uploads SET status = 'done', songs_found = $2, processed_at = now(), error = NULL
       WHERE id = $1`,
      [uploadId, songs.length]
    );

    return { status: "done", songs: songs.length, stats };
  } catch (err) {
    // A bad upload is the user's problem to see, not an incident: record the
    // reason on the row so the uploads page can show it, and do not rethrow —
    // retrying a corrupt zip will corrupt it again.
    const message = String(err.message || err).slice(0, 500);
    await pool.query(
      `UPDATE uploads SET status = 'failed', error = $2, processed_at = now() WHERE id = $1`,
      [uploadId, message]
    );
    return { status: "failed", error: message };
  }
}

module.exports = { parseUpload };
