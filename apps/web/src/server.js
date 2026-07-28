"use strict";

// Hosted-service entry point: build the real dependencies, wire them into the
// app factory, listen. Everything else lives in app.js, which is what makes the
// routes testable.

const path = require("node:path");
const { Pool } = require("pg");
const { PgBoss } = require("pg-boss");

const { databaseUrl } = require("./config");
const { createApp } = require("./app");
const { LocalBlobStore } = require("./blob-store");
const { ConsoleMailer } = require("./mailer");
const { migrate } = require("./migrate");
const { purgeExpired } = require("./auth");
const { PgBossQueue, QUEUE_PARSE_UPLOAD, QUEUE_FETCH_LYRICS } = require("./queue");

const PORT = process.env.PORT || 3001;
const BASE_URL = process.env.BASE_URL || `http://127.0.0.1:${PORT}`;
const BLOB_DIR = process.env.BLOB_DIR || path.join(__dirname, "..", "blobs");
const IS_PRODUCTION = process.env.NODE_ENV === "production";

async function main() {
  const pool = new Pool({ connectionString: databaseUrl() });

  // Migrating on boot is safe because the runner takes an advisory lock: start
  // ten app servers at once and exactly one migrates while the others wait.
  await migrate(pool, { log: (m) => console.log(m) });

  // The API only ever ENQUEUES; src/worker.js is what consumes. Creating the
  // queues here too means starting the API first does not fail.
  const boss = new PgBoss({ connectionString: databaseUrl() });
  boss.on("error", (err) => console.error("pg-boss:", err.message));
  await boss.start();
  await boss.createQueue(QUEUE_PARSE_UPLOAD);
  await boss.createQueue(QUEUE_FETCH_LYRICS);

  const app = createApp({
    pool,
    queue: new PgBossQueue(boss),
    blobStore: new LocalBlobStore(BLOB_DIR),
    // ConsoleMailer prints the login link instead of sending it, which is fine
    // for development and would be a silent authentication hole in production.
    mailer: new ConsoleMailer(),
    baseUrl: BASE_URL,
    secureCookies: IS_PRODUCTION,
  });

  if (IS_PRODUCTION) {
    throw new Error(
      "No production mailer is configured yet — sign-in links would only be " +
        "printed to the log. Wire a real Mailer before setting NODE_ENV=production."
    );
  }

  // Expired sessions and used login tokens are dead weight, not state.
  const purge = setInterval(() => {
    purgeExpired(pool).catch((err) => console.error("purge failed:", err.message));
  }, 60 * 60 * 1000);
  purge.unref();

  const server = app.listen(PORT, () => {
    console.log(`listening on ${BASE_URL}`);
    console.log(`blobs in ${BLOB_DIR}`);
    console.log("mailer: console (sign-in links are printed here, not emailed)");
    console.log("note: run `node src/worker.js` too, or uploads stay pending");
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      server.close(async () => {
        await boss.stop({ graceful: true }).catch(() => {});
        await pool.end().catch(() => {});
        process.exit(0);
      });
    });
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
