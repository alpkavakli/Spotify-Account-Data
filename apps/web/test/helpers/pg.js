"use strict";

// Test database helpers.
//
// These tests run against a REAL Postgres, not a mock. A mock of a database
// proves the mock behaves the way you imagined; the point of this step is to
// find out whether POSTGRES behaves the way we imagined — generated tsvector
// columns, cascade deletes, check constraints, and the JavaScript types
// node-postgres hands back. None of that can be faked usefully.
//
// If Postgres is not running the tests SKIP with an explanation rather than
// fail, so `npm test` at the repo root stays green for someone who has only
// cloned the repo to work on the Personal Edition.

const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Client, Pool } = require("pg");

const { testDatabaseUrl } = require("../../src/config");
const { migrate } = require("../../src/migrate");

const SKIP_MESSAGE =
  "Postgres is not reachable — run `npm run db:up --workspace @lyricsearch/web` " +
  "(see apps/web/README.md)";

/** The admin connection: the `postgres` database always exists, ours may not. */
function adminUrl() {
  const url = new URL(testDatabaseUrl());
  url.pathname = "/postgres";
  return url.toString();
}

// Each test FILE gets its own database.
//
// node --test runs files in parallel processes, and these helpers drop and
// recreate their database — so two files sharing one name tear down each
// other's connections mid-test. The failures look like schema bugs and are not.
function databaseName(suffix) {
  const base = new URL(testDatabaseUrl()).pathname.slice(1);
  return suffix ? `${base}_${suffix}` : base;
}

function databaseUrlFor(suffix) {
  const url = new URL(testDatabaseUrl());
  url.pathname = "/" + databaseName(suffix);
  return url.toString();
}

// `node:test` evaluates `describe(..., { skip })` synchronously, before any
// hook can run — so the probe has to be synchronous too, and connecting to
// Postgres is not. Spawning a child process to do it is the honest way to get a
// synchronous answer out of an asynchronous check. It costs ~150ms, once.
let availability = null;
function postgresAvailable() {
  if (availability !== null) return availability;
  try {
    execFileSync(
      process.execPath,
      [
        "-e",
        `const {Client}=require("pg");
         const c=new Client({connectionString:process.env.PROBE_URL,
                             connectionTimeoutMillis:3000});
         c.connect().then(()=>c.end()).then(()=>process.exit(0),()=>process.exit(1));`,
      ],
      {
        cwd: path.join(__dirname, "..", ".."),
        env: { ...process.env, PROBE_URL: adminUrl() },
        stdio: "ignore",
        timeout: 15000,
      }
    );
    availability = true;
  } catch {
    availability = false;
  }
  return availability;
}

/** `false` when Postgres is up, the skip reason when it is not. */
function skipWithoutPostgres() {
  return postgresAvailable() ? false : SKIP_MESSAGE;
}

async function recreateDatabase(suffix) {
  const name = databaseName(suffix);
  const admin = new Client({ connectionString: adminUrl() });
  await admin.connect();
  try {
    // WITH (FORCE) evicts anything a previous run left connected.
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${quoteIdent(name)}`);
  } finally {
    await admin.end();
  }
  return new Pool({ connectionString: databaseUrlFor(suffix) });
}

/**
 * A pool on a freshly-migrated test database.
 *
 * Dropped and recreated every time, so each run starts from the schema the
 * migrations actually produce rather than from whatever an earlier run left
 * behind. That is the only way a schema test means anything.
 *
 * @param {string} suffix  unique per test FILE — see databaseName()
 */
async function freshDatabase(suffix) {
  const pool = await recreateDatabase(suffix);
  await migrate(pool);
  return pool;
}

/** An empty database with NO migrations applied, for testing the runner itself. */
async function emptyDatabase(suffix) {
  return recreateDatabase(suffix);
}

function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

let userSeq = 0;
/** Insert a user and return its id — most tests need one to hang data off. */
async function createUser(pool, email) {
  const { rows } = await pool.query(
    "INSERT INTO users (email) VALUES ($1) RETURNING id",
    [email || `user${++userSeq}.${process.pid}@example.com`]
  );
  return rows[0].id;
}

/** Insert a song into the global catalogue and return its id. */
async function createSong(pool, { match_key, artist = "A", track = "T", album = null, uri = null } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO songs (match_key, artist, track, album, uri)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [match_key || `k${++userSeq}.${process.pid}`, artist, track, album, uri]
  );
  return rows[0].id;
}

module.exports = {
  postgresAvailable,
  skipWithoutPostgres,
  freshDatabase,
  emptyDatabase,
  createUser,
  createSong,
  SKIP_MESSAGE,
};
