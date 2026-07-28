"use strict";

// Configuration, read from the environment in one place.
//
// The default points at the docker-compose Postgres on port 5433 (not 5432, so
// it cannot collide with a Postgres already installed on the machine). In
// production DATABASE_URL is always set explicitly.

const path = require("node:path");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const DEV_DATABASE_URL = "postgres://lyricsearch:lyricsearch@127.0.0.1:5433/lyricsearch";

function databaseUrl() {
  return process.env.DATABASE_URL || DEV_DATABASE_URL;
}

/**
 * The database the tests run against.
 *
 * A SEPARATE database from the dev one, because the schema tests drop and
 * recreate their own schema and must never be able to do that to data you care
 * about. Override with TEST_DATABASE_URL.
 */
function testDatabaseUrl() {
  return (
    process.env.TEST_DATABASE_URL ||
    "postgres://lyricsearch:lyricsearch@127.0.0.1:5433/lyricsearch_test"
  );
}

module.exports = { databaseUrl, testDatabaseUrl, DEV_DATABASE_URL };
