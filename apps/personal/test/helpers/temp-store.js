"use strict";

// Throwaway SqliteAdapter instances for tests.
//
// Every adapter gets its own fresh directory under the OS temp dir, so tests
// are isolated from each other and — importantly — nothing here can ever open,
// read or write your real apps/personal/Data/spotify.db.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { SqliteAdapter } = require("../../src/sqlite-adapter");

const created = [];

/** A new, empty SqliteAdapter in its own temp directory. */
function tempStore(opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lyricsearch-test-"));
  created.push(dir);
  return new SqliteAdapter(dir, opts);
}

/** Re-open an existing temp directory (used to test read-only mode). */
function reopenStore(dir, opts) {
  return new SqliteAdapter(dir, opts);
}

/** Delete every temp directory this process created. Call from test.after(). */
function cleanupTempStores() {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
  created.length = 0;
}

module.exports = { tempStore, reopenStore, cleanupTempStores };
