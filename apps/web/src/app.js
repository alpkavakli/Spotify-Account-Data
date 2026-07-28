"use strict";

// The hosted service's HTTP API, built as a factory — same pattern as
// apps/personal/src/app.js, for the same reason: nothing is constructed at
// import time, so tests hand in a throwaway database, a temp blob directory and
// a recording mailer.
//
// Note how similar the read routes are to the Personal Edition's. That is the
// whole return on Phase 0: the search, stats and song routes differ only in
// where `store` comes from — a PostgresAdapter scoped to the logged-in user
// instead of a process-wide SqliteAdapter. No route contains SQL, so no route
// can forget to filter by tenant.

const express = require("express");

const {
  queryWords,
  countOccurrences,
  aggregateTopWords,
} = require("@lyricsearch/core/search");

const { PostgresAdapter } = require("./postgres-adapter");
const { NullQueue } = require("./queue");
const auth = require("./auth");

// An export zip is a few MB; the cap is generous but finite, because "no limit"
// means one request can fill the disk.
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

/**
 * @param {object} deps
 * @param {import("pg").Pool} deps.pool
 * @param {import("./blob-store").BlobStore} deps.blobStore
 * @param {import("./mailer").Mailer} deps.mailer
 * @param {import("./queue").Queue} [deps.queue]  where upload parsing is handed off
 * @param {string} [deps.baseUrl]   used to build login links
 * @param {boolean} [deps.secureCookies]
 */
function createApp({
  pool,
  blobStore,
  mailer,
  queue = new NullQueue(),
  baseUrl = "http://127.0.0.1:3001",
  secureCookies = false,
}) {
  const app = express();
  app.set("trust proxy", true);

  app.use(express.json({ limit: "1mb" }));

  // ── session plumbing ────────────────────────────────────────────────────

  /** Attaches req.userId and req.store when a valid session cookie is present. */
  app.use(async (req, res, next) => {
    try {
      const token = auth.readCookie(req, auth.SESSION_COOKIE);
      const userId = await auth.resolveSession(pool, token);
      if (userId !== null) {
        req.userId = userId;
        // One adapter per request, scoped to this user. Constructing it here —
        // rather than passing a userId down into query helpers — is what makes
        // cross-tenant access take a bug in the adapter rather than a slip in a
        // route.
        req.store = new PostgresAdapter(pool, { userId });
      }
      next();
    } catch (err) {
      next(err);
    }
  });

  const requireUser = (req, res, next) =>
    req.userId ? next() : res.status(401).json({ error: "not signed in" });

  function setSessionCookie(res, token) {
    res.cookie(auth.SESSION_COOKIE, token, {
      httpOnly: true, // JavaScript must never be able to read the session
      sameSite: "lax", // survives the click-through from the email link
      secure: secureCookies,
      path: "/",
      maxAge: auth.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
    });
  }

  // ── health ──────────────────────────────────────────────────────────────

  app.get("/health", async (req, res) => {
    try {
      await pool.query("SELECT 1");
      res.json({ ok: true });
    } catch (err) {
      res.status(503).json({ ok: false, error: "database unavailable" });
    }
  });

  // ── accounts ────────────────────────────────────────────────────────────

  app.post("/auth/request-link", async (req, res, next) => {
    try {
      const email = auth.normalizeEmail(req.body?.email);
      if (!email) return res.status(400).json({ error: "a valid email is required" });

      const { token, rateLimited } = await auth.issueLoginToken(pool, email);

      if (token) {
        const link = `${baseUrl}/auth/callback?token=${encodeURIComponent(token)}`;
        await mailer.send({
          to: email,
          subject: "Your sign-in link",
          text:
            `Click to sign in:\n\n${link}\n\n` +
            `The link works once and expires in ${auth.LOGIN_TOKEN_TTL_MINUTES} minutes.\n` +
            `If you did not ask for it, you can ignore this email.`,
        });
      }

      // Always the same answer, whether the address is registered, unknown, or
      // rate-limited. Anything else turns this endpoint into a way to ask
      // "does this person have an account here?".
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  app.get("/auth/callback", async (req, res, next) => {
    try {
      const result = await auth.consumeLoginToken(pool, req.query.token);
      if (!result) {
        return res.status(400).json({ error: "that link is invalid, expired, or already used" });
      }
      const token = await auth.createSession(pool, result.userId, {
        userAgent: req.get("user-agent") || null,
      });
      setSessionCookie(res, token);
      res.json({ ok: true, isNewUser: result.isNewUser });
    } catch (err) {
      next(err);
    }
  });

  app.post("/auth/logout", async (req, res, next) => {
    try {
      await auth.destroySession(pool, auth.readCookie(req, auth.SESSION_COOKIE));
      res.clearCookie(auth.SESSION_COOKIE, { path: "/" });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  app.get("/me", async (req, res, next) => {
    try {
      if (!req.userId) return res.json({ signedIn: false });
      const { rows } = await pool.query(
        "SELECT email, display_name, created_at FROM users WHERE id = $1",
        [req.userId]
      );
      res.json({
        signedIn: true,
        email: rows[0].email,
        displayName: rows[0].display_name,
        createdAt: rows[0].created_at,
      });
    } catch (err) {
      next(err);
    }
  });

  app.delete("/me", requireUser, async (req, res, next) => {
    try {
      // One statement. Every per-user table cascades from users(id), so erasure
      // cannot rot as tables are added — see docs/06-DATA-MODEL.md.
      await pool.query("DELETE FROM users WHERE id = $1", [req.userId]);
      res.clearCookie(auth.SESSION_COOKIE, { path: "/" });
      res.json({ ok: true, deleted: true });
    } catch (err) {
      next(err);
    }
  });

  // ── uploads ─────────────────────────────────────────────────────────────

  // The raw bytes, not multipart: a browser can `fetch(url, {body: file})` and
  // an API client can pipe a file, with no parser and no dependency.
  const uploadBody = express.raw({
    type: () => true,
    limit: MAX_UPLOAD_BYTES,
  });

  app.post("/uploads", requireUser, uploadBody, async (req, res, next) => {
    try {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ error: "request body must be the export file" });
      }

      // Store the blob first: a row pointing at a blob that does not exist is
      // worse than a blob nothing points at, which is merely garbage to collect.
      const key = await blobStore.put(req.body);

      const filename = String(req.query.filename || "").slice(0, 255) || null;
      const { rows } = await pool.query(
        `INSERT INTO uploads (user_id, blob_key, filename, bytes)
         VALUES ($1, $2, $3, $4)
         RETURNING id, status, bytes, filename, created_at`,
        [req.userId, key, filename, req.body.length]
      );

      // Enqueue AFTER the row is committed, or the worker can pick up a job
      // for an upload it cannot see yet.
      await queue.enqueueParseUpload(rows[0].id);

      // 202, not 200: the parsing happens in the worker. Holding the request
      // open for a multi-minute ingest is exactly what the queue is for.
      res.status(202).json({ upload: rows[0] });
    } catch (err) {
      if (err.type === "entity.too.large") {
        return res.status(413).json({ error: "that file is too large" });
      }
      next(err);
    }
  });

  app.get("/uploads", requireUser, async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, filename, bytes, status, error, songs_found, created_at, processed_at
         FROM uploads WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [req.userId]
      );
      res.json({ uploads: rows });
    } catch (err) {
      next(err);
    }
  });

  // ── search & stats (the Personal Edition's routes, on a different store) ──

  app.get("/searchForWord", requireUser, async (req, res, next) => {
    try {
      const q = String(req.query.q || "").trim();
      if (!q) return res.status(400).json({ error: "missing query parameter: q" });

      const words = queryWords(q);
      if (!words) return res.status(400).json({ error: "empty query" });

      const rows = await req.store.searchByLyrics(words);

      res.json({
        query: q,
        count: rows.length,
        results: rows.map((r) => ({
          id: r.id,
          artist: r.artist,
          track: r.track,
          album: r.album,
          uri: r.uri,
          playCount: r.play_count,
          streamCount: r.stream_count,
          inLibrary: !!r.in_library,
          playlists: JSON.parse(r.playlists),
          snippet: r.snippet,
          occurrences: countOccurrences(r.body, q),
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  app.get("/song/:id", requireUser, async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return res.status(400).json({ error: "bad id" });

      const row = await req.store.getSong(id);
      // Also the answer when the song exists but belongs to someone else: the
      // adapter joins through user_songs, so "not yours" and "not found" are
      // indistinguishable from outside, which is the correct amount to reveal.
      if (!row) return res.status(404).json({ error: "not found" });

      res.json({
        id: row.id,
        artist: row.artist,
        track: row.track,
        album: row.album,
        uri: row.uri,
        playCount: row.play_count,
        streamCount: row.stream_count,
        minutesPlayed: Math.round(row.ms_played / 60000),
        inLibrary: !!row.in_library,
        playlists: JSON.parse(row.playlists),
        lyricsStatus: row.status || "pending",
        // NOTE: the hosted service must NEVER return the full lyric body — see
        // PROJECT_PLAN.md §3/§5. Search results carry a snippet; this route
        // deliberately reports only whether lyrics exist.
        hasLyrics: row.status === "ok",
      });
    } catch (err) {
      next(err);
    }
  });

  // Per-user top-words, cached on the ok-lyric count like the Personal Edition,
  // but keyed by user and bounded — an unbounded map keyed by tenant is a slow
  // memory leak in a multi-tenant process.
  const wordCache = new Map();
  const WORD_CACHE_MAX = 200;

  async function topWords(store, userId) {
    const okCount = await store.getOkLyricCount();
    const hit = wordCache.get(userId);
    if (hit && hit.okCount === okCount) return hit;

    const entry = { okCount, list: aggregateTopWords(await store.getOkLyricBodies(), 300) };
    wordCache.set(userId, entry);
    if (wordCache.size > WORD_CACHE_MAX) {
      wordCache.delete(wordCache.keys().next().value); // oldest insertion
    }
    return entry;
  }

  app.get("/topWords", requireUser, async (req, res, next) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 100, 300);
      const cache = await topWords(req.store, req.userId);
      res.json({ songsWithLyrics: cache.okCount, words: cache.list.slice(0, limit) });
    } catch (err) {
      next(err);
    }
  });

  app.get("/stats", requireUser, async (req, res, next) => {
    try {
      const [{ totals, topSongs, topArtists }, meta] = await Promise.all([
        req.store.getStats(),
        req.store.getMeta(),
      ]);
      res.json({
        tracks: totals.tracks,
        artists: totals.artists,
        plays: totals.plays,
        streams: totals.streams,
        hours: Math.round(totals.ms / 3600000),
        coverage: {
          from: meta.history_from || null,
          to: meta.history_to || null,
          source: meta.history_source || null,
          skipThresholdSeconds: meta.skip_threshold_ms
            ? Number(meta.skip_threshold_ms) / 1000
            : null,
          ingestedAt: meta.ingested_at || null,
        },
        topSongs: topSongs.map((s) => ({
          id: s.id,
          artist: s.artist,
          track: s.track,
          plays: s.play_count,
          streams: s.stream_count,
          minutes: Math.round(s.ms_played / 60000),
        })),
        topArtists: topArtists.map((a) => ({
          artist: a.artist,
          songs: a.songs,
          plays: a.plays,
          streams: a.streams,
          hours: +(a.ms / 3600000).toFixed(1),
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  app.get("/status", requireUser, async (req, res, next) => {
    try {
      const { tracks, statuses } = await req.store.getStatus();
      res.json({
        tracks,
        processed: statuses.reduce((s, r) => s + r.count, 0),
        lyrics: Object.fromEntries(statuses.map((r) => [r.status, r.count])),
      });
    } catch (err) {
      next(err);
    }
  });

  // ── errors ──────────────────────────────────────────────────────────────

  app.use((req, res) => res.status(404).json({ error: "not found" }));

  // Four arguments: Express identifies error handlers by arity.
  app.use((err, req, res, next) => {
    // Never leak a database message to a client — it names tables and columns.
    req.log?.error?.(err) ?? console.error(err);
    res.status(500).json({ error: "internal error" });
  });

  return app;
}

module.exports = { createApp, MAX_UPLOAD_BYTES };
