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
const { SmtpMailer, mailerFromEnv } = require("./mailer");
const { migrate } = require("./migrate");
const { purgeExpired } = require("./auth");
const { PgBossQueue, QUEUE_PARSE_UPLOAD, QUEUE_FETCH_LYRICS } = require("./queue");

const PORT = process.env.PORT || 3001;
const BASE_URL = process.env.BASE_URL || `http://127.0.0.1:${PORT}`;
const BLOB_DIR = process.env.BLOB_DIR || path.join(__dirname, "..", "blobs");
const IS_PRODUCTION = process.env.NODE_ENV === "production";

async function main() {
  // Configuration first, and everything that can be wrong is wrong before we
  // open a connection. A process that fails at boot is a deploy that rolls
  // back; a process that fails on the first sign-in is an outage nobody sees
  // until a user reports it.
  const mailer = mailerFromEnv();

  if (IS_PRODUCTION) {
    if (!process.env.BASE_URL) {
      throw new Error(
        "BASE_URL is not set. It is the public origin sign-in links are built " +
          "from, so the default (http://127.0.0.1) would email links that reach " +
          "nobody. Set it to https://your-domain."
      );
    }
    if (!BASE_URL.startsWith("https://")) {
      // Session cookies are set `secure` in production, so a browser on a
      // plaintext origin accepts the redirect and silently drops the cookie —
      // sign-in appears to work and the user lands back on the sign-in page.
      throw new Error(`BASE_URL must be https:// in production, got ${BASE_URL}`);
    }
    // Credentials that are merely wrong are invisible until someone tries to
    // log in. Ask the server now, while a failure is still ours to notice.
    if (mailer instanceof SmtpMailer) await mailer.verify();
  }

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
    mailer,
    baseUrl: BASE_URL,
    secureCookies: IS_PRODUCTION,
  });

  // Expired sessions and used login tokens are dead weight, not state.
  const purge = setInterval(() => {
    purgeExpired(pool).catch((err) => console.error("purge failed:", err.message));
  }, 60 * 60 * 1000);
  purge.unref();

  const server = app.listen(PORT, () => {
    console.log(`listening on ${BASE_URL}`);
    console.log(`blobs in ${BLOB_DIR}`);
    console.log(
      mailer instanceof SmtpMailer
        ? `mailer: smtp (from ${mailer.from})`
        : "mailer: console (sign-in links are printed here, not emailed)"
    );
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
