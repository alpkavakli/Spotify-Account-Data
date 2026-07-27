"use strict";

// The single SqliteAdapter instance for the Personal Edition (single-user, one
// process). Everything that needs persistence requires this module. Swapping to a
// different backend is a one-line change here — nothing else touches the database.

const path = require("node:path");
const { SqliteAdapter } = require("./sqlite-adapter");

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(__dirname, "..", "Data");

module.exports = new SqliteAdapter(DATA_DIR);
