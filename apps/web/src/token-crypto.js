"use strict";

// Encrypting third-party credentials at rest.
//
// A Spotify refresh token is a long-lived key to somebody's Spotify account. In
// the hosted service they sit in one table, for every user at once, and that
// table gets dumped nightly by deploy/backup.sh and copied off the box. Stored
// as plaintext, a single leaked backup file is every connected user's account —
// not "their data in our service", their account, on a service we do not run.
//
// So they are encrypted before they reach a column, with a key that lives in the
// environment rather than in the database. That does not help against an
// attacker who owns the running process (they have the key), and it is not meant
// to: the threat it answers is the realistic one — a dump, a backup, a snapshot,
// a stolen disk, an over-broad SELECT in a support script.
//
// The Personal Edition deliberately does NOT do this. Its SQLite file is on the
// user's own machine and the key would have to live beside it, which buys
// nothing.

const crypto = require("node:crypto");

const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12; // 96 bits — the size GCM is defined for
const TAG_BYTES = 16;

const b64 = (buf) => buf.toString("base64url");
const unb64 = (str) => Buffer.from(str, "base64url");

/**
 * A set of keys: one that encrypts, any number that can still decrypt.
 *
 * Rotation is the reason this is a keyring and not a key. Re-encrypting every
 * row at the moment you change keys is a migration nobody wants to run under
 * pressure; carrying the old key until the rows age out is the cheap version,
 * and it only works if the ciphertext says which key made it.
 */
class TokenCipher {
  /**
   * @param {{id: string, key: Buffer}[]} keys  the FIRST entry encrypts; the
   *   rest exist so tokens written before a rotation still open.
   */
  constructor(keys) {
    if (!Array.isArray(keys) || keys.length === 0) {
      throw new Error("TokenCipher needs at least one key");
    }

    this.keys = new Map();
    for (const { id, key } of keys) {
      if (!/^[A-Za-z0-9_-]+$/.test(String(id || ""))) {
        // The id goes into the ciphertext string as a dot-separated field, so a
        // dot or a colon in it would silently corrupt parsing.
        throw new Error(`key id must be [A-Za-z0-9_-]+, got ${JSON.stringify(id)}`);
      }
      if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
        throw new Error(`key ${id} must be exactly ${KEY_BYTES} bytes, got ${key?.length}`);
      }
      if (this.keys.has(id)) throw new Error(`duplicate key id ${id}`);
      this.keys.set(id, key);
    }

    this.activeKeyId = keys[0].id;
  }

  /**
   * @param {string} plaintext
   * @param {string} context  bound to the ciphertext and required to open it —
   *   pass the user id. It means a token blob lifted from one row and dropped
   *   into another fails loudly instead of decrypting into the wrong account.
   * @returns {string} `v1.<keyId>.<iv>.<tag>.<ciphertext>`, all base64url
   */
  encrypt(plaintext, context) {
    if (typeof plaintext !== "string" || plaintext === "") {
      throw new Error("plaintext must be a non-empty string");
    }
    if (typeof context !== "string" || context === "") {
      throw new Error("context must be a non-empty string");
    }

    const key = this.keys.get(this.activeKeyId);
    // A fresh random IV per call. Reusing one with the same key is the single
    // way to break GCM completely, so it is never derived from anything.
    const iv = crypto.randomBytes(IV_BYTES);

    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    cipher.setAAD(Buffer.from(context, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);

    return [VERSION, this.activeKeyId, b64(iv), b64(cipher.getAuthTag()), b64(ciphertext)].join(".");
  }

  /**
   * @param {string} encoded  a string produced by encrypt()
   * @param {string} context  must be exactly what encrypt() was given
   * @returns {string} the plaintext
   * @throws if the ciphertext was tampered with, the context differs, or the
   *   key that made it is not in this ring
   */
  decrypt(encoded, context) {
    if (typeof encoded !== "string") throw new Error("ciphertext must be a string");

    const parts = encoded.split(".");
    if (parts.length !== 5) throw new Error("ciphertext is malformed");

    const [version, keyId, ivB64, tagB64, dataB64] = parts;
    if (version !== VERSION) throw new Error(`unsupported ciphertext version ${version}`);

    const key = this.keys.get(keyId);
    if (!key) {
      // Worth its own message: this is what a botched key rotation looks like,
      // and it is recoverable — put the old key back in the ring.
      throw new Error(`no key "${keyId}" in the keyring — was a key removed before its rows expired?`);
    }

    const iv = unb64(ivB64);
    const tag = unb64(tagB64);
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
      throw new Error("ciphertext is malformed");
    }

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAAD(Buffer.from(String(context), "utf8"));
    decipher.setAuthTag(tag);

    // final() is what verifies the tag. Node throws
    // "Unsupported state or unable to authenticate data" — reworded, because
    // this failure means tampering or a mismatched context, not a bug.
    try {
      return Buffer.concat([decipher.update(unb64(dataB64)), decipher.final()]).toString("utf8");
    } catch {
      throw new Error("ciphertext failed authentication — wrong context, or it was altered");
    }
  }

  /** Was this written by a key that is no longer the active one? */
  needsRotation(encoded) {
    return typeof encoded === "string" && encoded.split(".")[1] !== this.activeKeyId;
  }
}

/**
 * Build the keyring from the environment.
 *
 *   TOKEN_ENCRYPTION_KEYS="2:<base64 32 bytes>,1:<base64 32 bytes>"
 *
 * The FIRST key encrypts; the others only decrypt. Rotating is therefore:
 * generate a key, prepend it, redeploy — old rows keep opening, new ones use the
 * new key, and `needsRotation()` says which rows are still on the old one.
 *
 *   openssl rand -base64 32
 *
 * There is deliberately no default and no development fallback. Every other
 * fallback in this codebase degrades to something visibly wrong (the console
 * mailer prints instead of sending); a default encryption key degrades to
 * something that looks identical to working and is worth nothing, and it would
 * eventually be the key in production.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {TokenCipher}
 */
function cipherFromEnv(env = process.env) {
  const raw = (env.TOKEN_ENCRYPTION_KEYS || "").trim();
  if (!raw) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEYS is not set. Spotify refresh tokens are stored " +
        'encrypted; generate a key with `openssl rand -base64 32` and set ' +
        'TOKEN_ENCRYPTION_KEYS="1:<that key>".'
    );
  }

  const keys = raw.split(",").map((entry) => {
    const at = entry.indexOf(":");
    if (at < 1) {
      throw new Error(`TOKEN_ENCRYPTION_KEYS entries must be "id:base64key", got ${JSON.stringify(entry)}`);
    }
    return {
      id: entry.slice(0, at).trim(),
      key: Buffer.from(entry.slice(at + 1).trim(), "base64"),
    };
  });

  return new TokenCipher(keys);
}

/** A fresh key, formatted for the env var. Used by docs and by the tests. */
function generateKey() {
  return crypto.randomBytes(KEY_BYTES).toString("base64");
}

module.exports = { TokenCipher, cipherFromEnv, generateKey, KEY_BYTES };
