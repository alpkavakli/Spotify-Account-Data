"use strict";

// Passwordless accounts: email a one-time link, exchange it for a session.
//
// Why no passwords: they are the largest liability a small service can take on
// (hashing, resets, reuse, breach disclosure) and they buy nothing here — every
// password reset flow is already "prove you control this inbox", so this just
// removes the redundant step. docs/01-DECISIONS.md.
//
// Two rules run through the whole file:
//   1. RAW TOKENS NEVER TOUCH THE DATABASE. Only SHA-256 digests are stored, so
//      a leaked dump is not a set of working login links or live sessions.
//   2. Signing up and signing in are the same flow. The account is created when
//      a link is first used, which is also why login_tokens is keyed by email
//      rather than by user id.

const crypto = require("node:crypto");

const LOGIN_TOKEN_TTL_MINUTES = 15;
const SESSION_TTL_DAYS = 30;
const SESSION_COOKIE = "ls_session";

// A link is useless once used, so the cap is about inbox abuse — stopping
// someone using our mail server to spam an address they do not own.
const MAX_LINKS_PER_HOUR = 5;

/** 32 random bytes, url-safe. Long enough that guessing is not a strategy. */
function newToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest();
}

/**
 * Issue a login token for an email address.
 *
 * @returns {Promise<{token: string|null, rateLimited: boolean}>}
 *   `token` is the RAW token — mail it, then forget it. It cannot be recovered
 *   from the database, which is the point.
 */
async function issueLoginToken(pool, email) {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM login_tokens
     WHERE email = $1 AND created_at > now() - interval '1 hour'`,
    [email]
  );
  if (rows[0].n >= MAX_LINKS_PER_HOUR) return { token: null, rateLimited: true };

  const token = newToken();
  await pool.query(
    `INSERT INTO login_tokens (token_hash, email, expires_at)
     VALUES ($1, $2, now() + ($3 || ' minutes')::interval)`,
    [hashToken(token), email, String(LOGIN_TOKEN_TTL_MINUTES)]
  );
  return { token, rateLimited: false };
}

/**
 * Exchange a login token for a user id, creating the account if it is new.
 *
 * @returns {Promise<{userId: number, isNewUser: boolean}|null>} null if the
 *   token is unknown, expired, or already used.
 */
async function consumeLoginToken(pool, token) {
  if (!token) return null;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Marking consumed as part of the same statement that selects it is what
    // makes the link single-use even if it is clicked twice at once: the second
    // transaction finds consumed_at already set and matches nothing.
    const { rows } = await client.query(
      `UPDATE login_tokens SET consumed_at = now()
       WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()
       RETURNING email`,
      [hashToken(token)]
    );
    if (rows.length === 0) {
      await client.query("ROLLBACK");
      return null;
    }

    const email = rows[0].email;
    const inserted = await client.query(
      `INSERT INTO users (email) VALUES ($1)
       ON CONFLICT (email) DO NOTHING
       RETURNING id`,
      [email]
    );

    let userId;
    let isNewUser;
    if (inserted.rows.length > 0) {
      userId = inserted.rows[0].id;
      isNewUser = true;
    } else {
      const existing = await client.query("SELECT id FROM users WHERE email = $1", [email]);
      userId = existing.rows[0].id;
      isNewUser = false;
    }

    await client.query("COMMIT");
    return { userId, isNewUser };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** @returns {Promise<string>} the RAW session token — put it in a cookie. */
async function createSession(pool, userId, { userAgent = null } = {}) {
  const token = newToken();
  await pool.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at, user_agent)
     VALUES ($1, $2, now() + ($3 || ' days')::interval, $4)`,
    [hashToken(token), userId, String(SESSION_TTL_DAYS), userAgent]
  );
  return token;
}

/**
 * Resolve a session token to a user id, or null.
 *
 * The UPDATE ... RETURNING both validates and touches last_seen_at in one round
 * trip; an expired row matches nothing, so expiry needs no separate check.
 */
async function resolveSession(pool, token) {
  if (!token) return null;
  const { rows } = await pool.query(
    `UPDATE sessions SET last_seen_at = now()
     WHERE token_hash = $1 AND expires_at > now()
     RETURNING user_id`,
    [hashToken(token)]
  );
  return rows.length ? rows[0].user_id : null;
}

async function destroySession(pool, token) {
  if (!token) return;
  await pool.query("DELETE FROM sessions WHERE token_hash = $1", [hashToken(token)]);
}

/** Remove expired rows. Cheap enough to run on a timer or from the worker. */
async function purgeExpired(pool) {
  const sessions = await pool.query("DELETE FROM sessions WHERE expires_at <= now()");
  const tokens = await pool.query(
    "DELETE FROM login_tokens WHERE expires_at <= now() OR consumed_at IS NOT NULL"
  );
  return { sessions: sessions.rowCount, loginTokens: tokens.rowCount };
}

/**
 * Parse a Cookie header.
 *
 * Hand-rolled rather than adding cookie-parser: it is six lines, and this
 * project's dependency budget is deliberately small (node:sqlite, built-in
 * fetch, node:test).
 */
function readCookie(req, name) {
  const header = req.headers?.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

/** Normalise an email, or null if it is not plausibly one. */
function normalizeEmail(input) {
  const email = String(input || "").trim().toLowerCase();
  // Deliberately permissive: the only real proof an address works is that the
  // link arrives, and over-strict regexes reject valid addresses.
  if (email.length < 3 || email.length > 254) return null;
  if (!/^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

module.exports = {
  SESSION_COOKIE,
  LOGIN_TOKEN_TTL_MINUTES,
  SESSION_TTL_DAYS,
  MAX_LINKS_PER_HOUR,
  newToken,
  hashToken,
  issueLoginToken,
  consumeLoginToken,
  createSession,
  resolveSession,
  destroySession,
  purgeExpired,
  readCookie,
  normalizeEmail,
};
