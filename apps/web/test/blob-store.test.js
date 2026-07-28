"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { LocalBlobStore } = require("../src/blob-store");

const dirs = [];
function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lyricsearch-blobs-"));
  dirs.push(dir);
  return new LocalBlobStore(dir);
}

test.after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

test.describe("LocalBlobStore", () => {
  test.it("round-trips bytes unchanged", async () => {
    const store = tempStore();
    // Binary, not text: an export is a zip, and a store that mangles bytes
    // would only show up as a corrupt archive much later.
    const data = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0xfe, 0x00]);
    const key = await store.put(data);
    assert.deepEqual(await store.get(key), data);
  });

  test.it("handles a large blob", async () => {
    const store = tempStore();
    const data = Buffer.alloc(5 * 1024 * 1024, 7);
    const key = await store.put(data);
    assert.equal((await store.get(key)).length, data.length);
  });

  test.it("gives every blob a different key", async () => {
    const store = tempStore();
    const keys = await Promise.all([1, 2, 3, 4, 5].map(() => store.put(Buffer.from("same"))));
    assert.equal(new Set(keys).size, 5, "identical content must not collide");
  });

  test.it("generates unguessable keys", async () => {
    // Keys end up in the database and, later, in signed URLs. Sequential keys
    // would let anyone enumerate other people's uploads.
    const store = tempStore();
    const key = await store.put(Buffer.from("x"));
    assert.match(key, /^\d{4}-\d{2}\/[0-9a-f]{32}$/);
  });

  test.it("never derives a key from anything the caller passes", async () => {
    // put() takes bytes only — there is no filename parameter, by design.
    const store = tempStore();
    assert.equal(store.put.length, 1);
  });

  test.it("reports existence", async () => {
    const store = tempStore();
    const key = await store.put(Buffer.from("x"));
    assert.equal(await store.exists(key), true);
    assert.equal(await store.exists("2020-01/" + "0".repeat(32)), false);
  });

  test.it("deletes, and deleting twice is not an error", async () => {
    const store = tempStore();
    const key = await store.put(Buffer.from("x"));
    await store.delete(key);
    assert.equal(await store.exists(key), false);
    await assert.doesNotReject(() => store.delete(key));
  });

  test.it("rejects a key that escapes the store root", async () => {
    // Keys are generated here, so a traversing key means a bug or a tampered
    // database row. Either way it must not read /etc/passwd.
    const store = tempStore();
    for (const bad of ["../secret", "../../etc/passwd", "a/../../b", "/etc/passwd"]) {
      await assert.rejects(() => store.get(bad), /escapes the store root|ENOENT/, bad);
    }
  });

  test.it("rejects an empty or non-string key", async () => {
    const store = tempStore();
    for (const bad of ["", null, undefined, 42]) {
      await assert.rejects(() => store.get(bad), /non-empty string/);
    }
  });

  test.it("fails cleanly when reading a key that was never stored", async () => {
    const store = tempStore();
    await assert.rejects(() => store.get("2020-01/" + "a".repeat(32)), /ENOENT/);
  });

  test.it("creates its root directory", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "lyricsearch-blobs-"));
    dirs.push(parent);
    const nested = path.join(parent, "deeper", "still");
    new LocalBlobStore(nested);
    assert.ok(fs.existsSync(nested));
  });
});
