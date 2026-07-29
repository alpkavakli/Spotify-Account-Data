"use strict";

// Encryption of stored Spotify credentials. No database, no network.
//
// These assert the properties, not the implementation: that ciphertext does not
// contain the plaintext, that tampering is detected, that a blob moved between
// users refuses to open, and that a key rotation does not strand old rows.
// Anything that only checks "encrypt then decrypt gives it back" would pass just
// as happily on base64.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const { TokenCipher, cipherFromEnv, generateKey, KEY_BYTES } = require("../src/token-crypto");

const KEY_A = crypto.randomBytes(KEY_BYTES);
const KEY_B = crypto.randomBytes(KEY_BYTES);

const cipher = () => new TokenCipher([{ id: "1", key: KEY_A }]);

// A realistic Spotify refresh token: long, base64-ish, no structure to lean on.
const TOKEN = "AQD" + crypto.randomBytes(96).toString("base64url");
const USER = "8f3c1a2e-0b47-4d9a-9c11-6e2f5d7a4b30";

test.describe("TokenCipher", () => {
  test.it("round-trips a refresh token", () => {
    const c = cipher();
    assert.equal(c.decrypt(c.encrypt(TOKEN, USER), USER), TOKEN);
  });

  test.it("the ciphertext does not contain the token", () => {
    // The assertion that separates encryption from encoding.
    const encoded = cipher().encrypt(TOKEN, USER);
    assert.equal(encoded.includes(TOKEN), false);
    assert.equal(Buffer.from(encoded).includes(Buffer.from(TOKEN)), false);
    assert.equal(encoded.includes(TOKEN.slice(0, 24)), false);
  });

  test.it("encrypts the same token differently every time", () => {
    // A deterministic ciphertext leaks equality: anyone reading the table could
    // see which rows hold the same credential, and a repeated IV under one key
    // breaks GCM outright.
    const c = cipher();
    const seen = new Set(Array.from({ length: 20 }, () => c.encrypt(TOKEN, USER)));
    assert.equal(seen.size, 20);
  });

  test.it("still decrypts all of those to the same token", () => {
    const c = cipher();
    for (let i = 0; i < 20; i++) assert.equal(c.decrypt(c.encrypt(TOKEN, USER), USER), TOKEN);
  });

  test.it("refuses a token encrypted for a different user", () => {
    // The context is the user id, so a blob lifted out of one row and written
    // into another does not quietly decrypt into the wrong account — which is
    // the multi-tenant failure that matters here.
    const c = cipher();
    const mine = c.encrypt(TOKEN, USER);
    assert.throws(() => c.decrypt(mine, "someone-else"), /failed authentication/);
  });

  test.it("detects a flipped bit in the ciphertext", () => {
    const c = cipher();
    const parts = c.encrypt(TOKEN, USER).split(".");
    const data = Buffer.from(parts[4], "base64url");
    data[0] ^= 0x01;
    parts[4] = data.toString("base64url");
    assert.throws(() => c.decrypt(parts.join("."), USER), /failed authentication/);
  });

  test.it("detects a swapped authentication tag", () => {
    const c = cipher();
    const a = c.encrypt(TOKEN, USER).split(".");
    const b = c.encrypt(TOKEN, USER).split(".");
    a[3] = b[3];
    assert.throws(() => c.decrypt(a.join("."), USER), /failed authentication/);
  });

  test.it("detects a swapped IV", () => {
    const c = cipher();
    const a = c.encrypt(TOKEN, USER).split(".");
    const b = c.encrypt(TOKEN, USER).split(".");
    a[2] = b[2];
    assert.throws(() => c.decrypt(a.join("."), USER), /failed authentication/);
  });

  test.it("rejects a token from an entirely different key", () => {
    const mine = new TokenCipher([{ id: "1", key: KEY_A }]).encrypt(TOKEN, USER);
    const theirs = new TokenCipher([{ id: "1", key: KEY_B }]);
    assert.throws(() => theirs.decrypt(mine, USER), /failed authentication/);
  });

  test.it("rejects malformed input rather than guessing", () => {
    const c = cipher();
    for (const bad of ["", "not-a-ciphertext", "v1.1.aaa", "v1.1.a.b.c.d", TOKEN]) {
      assert.throws(() => c.decrypt(bad, USER), /malformed|unsupported|no key/);
    }
  });

  test.it("refuses a ciphertext version it does not know", () => {
    // The version field exists so the format can change without a silent
    // mis-parse. Prove it is actually checked.
    const c = cipher();
    const parts = c.encrypt(TOKEN, USER).split(".");
    parts[0] = "v2";
    assert.throws(() => c.decrypt(parts.join("."), USER), /unsupported ciphertext version v2/);
  });

  test.it("survives tokens with awkward characters", () => {
    const c = cipher();
    for (const value of ["a", "ünïcødé-tøken", "with.dots.everywhere", "x".repeat(4096)]) {
      assert.equal(c.decrypt(c.encrypt(value, USER), USER), value);
    }
  });

  test.it("needs a non-empty plaintext and context", () => {
    const c = cipher();
    assert.throws(() => c.encrypt("", USER), /plaintext/);
    assert.throws(() => c.encrypt(TOKEN, ""), /context/);
    assert.throws(() => c.encrypt(null, USER), /plaintext/);
  });
});

test.describe("key rotation", () => {
  const old = new TokenCipher([{ id: "1", key: KEY_A }]);
  // The new key goes FIRST: it encrypts, the old one is kept only to open rows
  // written before the rotation.
  const rotated = new TokenCipher([
    { id: "2", key: KEY_B },
    { id: "1", key: KEY_A },
  ]);

  test.it("still opens tokens written before the rotation", () => {
    // Otherwise rotating a key means every connected user is silently logged
    // out of Spotify, and the only fix is a key you may have already deleted.
    assert.equal(rotated.decrypt(old.encrypt(TOKEN, USER), USER), TOKEN);
  });

  test.it("writes new tokens with the new key", () => {
    assert.equal(rotated.encrypt(TOKEN, USER).split(".")[1], "2");
  });

  test.it("reports which stored tokens are still on the old key", () => {
    assert.equal(rotated.needsRotation(old.encrypt(TOKEN, USER)), true);
    assert.equal(rotated.needsRotation(rotated.encrypt(TOKEN, USER)), false);
  });

  test.it("says so clearly when a key was retired too early", () => {
    // The recoverable disaster: rows encrypted with a key no longer deployed.
    // The message has to name the cause, because the fix is to put it back.
    const onlyNew = new TokenCipher([{ id: "2", key: KEY_B }]);
    assert.throws(() => onlyNew.decrypt(old.encrypt(TOKEN, USER), USER), /no key "1"/);
  });
});

test.describe("keyring validation", () => {
  test.it("rejects a key that is not 32 bytes", () => {
    // AES-256 needs exactly 32. A short base64 string would otherwise fail deep
    // inside node's crypto with a message about nothing in particular.
    assert.throws(() => new TokenCipher([{ id: "1", key: crypto.randomBytes(16) }]), /32 bytes/);
  });

  test.it("rejects a key id that would corrupt the encoding", () => {
    // The id is a dot-separated field inside the ciphertext.
    for (const id of ["a.b", "a:b", "", "a,b"]) {
      assert.throws(() => new TokenCipher([{ id, key: KEY_A }]), /key id must be/);
    }
  });

  test.it("rejects duplicate key ids", () => {
    assert.throws(
      () => new TokenCipher([{ id: "1", key: KEY_A }, { id: "1", key: KEY_B }]),
      /duplicate key id/
    );
  });

  test.it("rejects an empty keyring", () => {
    assert.throws(() => new TokenCipher([]), /at least one key/);
  });
});

test.describe("cipherFromEnv", () => {
  test.it("builds a working cipher from one key", () => {
    const c = cipherFromEnv({ TOKEN_ENCRYPTION_KEYS: `1:${generateKey()}` });
    assert.equal(c.decrypt(c.encrypt(TOKEN, USER), USER), TOKEN);
  });

  test.it("takes the first key as the active one", () => {
    const c = cipherFromEnv({ TOKEN_ENCRYPTION_KEYS: `9:${generateKey()},8:${generateKey()}` });
    assert.equal(c.activeKeyId, "9");
    assert.equal(c.keys.size, 2);
  });

  test.it("tolerates whitespace around entries", () => {
    const c = cipherFromEnv({ TOKEN_ENCRYPTION_KEYS: ` 1: ${generateKey()} , 2: ${generateKey()} ` });
    assert.equal(c.activeKeyId, "1");
  });

  test.it("REFUSES to invent a key when none is configured", () => {
    // Every other fallback here degrades to something visibly wrong. A default
    // encryption key degrades to something indistinguishable from working, and
    // would end up being the key in production.
    assert.throws(() => cipherFromEnv({}), /TOKEN_ENCRYPTION_KEYS is not set/);
    assert.throws(() => cipherFromEnv({ TOKEN_ENCRYPTION_KEYS: "   " }), /not set/);
  });

  test.it("explains a malformed entry", () => {
    assert.throws(() => cipherFromEnv({ TOKEN_ENCRYPTION_KEYS: "nokeyhere" }), /id:base64key/);
  });

  test.it("catches a key of the wrong length from the environment", () => {
    // The likely typo: a truncated paste, or `openssl rand -hex 32` (64 chars,
    // which base64-decodes to 48 bytes) instead of -base64.
    assert.throws(() => cipherFromEnv({ TOKEN_ENCRYPTION_KEYS: "1:c2hvcnQ=" }), /32 bytes/);
    assert.throws(
      () => cipherFromEnv({ TOKEN_ENCRYPTION_KEYS: `1:${crypto.randomBytes(32).toString("hex")}` }),
      /32 bytes/
    );
  });
});

test.describe("generateKey", () => {
  test.it("produces a key the env parser accepts", () => {
    const c = cipherFromEnv({ TOKEN_ENCRYPTION_KEYS: `1:${generateKey()}` });
    assert.equal(c.keys.get("1").length, KEY_BYTES);
  });

  test.it("never produces the same key twice", () => {
    assert.equal(new Set(Array.from({ length: 50 }, generateKey)).size, 50);
  });
});
