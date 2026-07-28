"use strict";

// Forward-only SQL migrations.
//
// Deliberately about 80 lines instead of a migration framework. The rules are
// few and they matter more than the features:
//
//   1. Migrations are plain .sql files, applied in filename order. The schema is
//      readable as SQL by anyone, including future-you at 2am, with no DSL in
//      the way.
//   2. Forward only. There are no `down` migrations, because a rollback that
//      drops a column is a data-loss button that looks like an undo button. Fix
//      forward with a new migration.
//   3. Each file runs inside ONE transaction. Postgres has transactional DDL, so
//      a migration that fails halfway leaves the database exactly as it was —
//      no half-applied schema to untangle by hand.
//   4. Applied migrations are recorded in schema_migrations and never re-run.
//   5. A session-level advisory lock wraps the whole run, so if two app
//      instances boot at once only one migrates and the other waits. This
//      matters the moment there is more than one app server, which is the
//      entire point of the stateless design.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");

// Any constant works; it just has to be the same in every process.
const ADVISORY_LOCK_KEY = 8147200533;

/** @returns {{name: string, sql: string, checksum: string}[]} in filename order */
function loadMigrations(dir = MIGRATIONS_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
    .map((name) => {
      const sql = fs.readFileSync(path.join(dir, name), "utf8");
      return {
        name,
        sql,
        checksum: crypto.createHash("sha256").update(sql).digest("hex"),
      };
    });
}

/**
 * Apply every migration that has not been applied yet.
 *
 * @param {import("pg").Pool|import("pg").Client} db
 * @param {{dir?: string, log?: (msg: string) => void}} [opts]
 * @returns {Promise<{applied: string[], alreadyApplied: string[]}>}
 */
async function migrate(db, { dir = MIGRATIONS_DIR, log = () => {} } = {}) {
  const migrations = loadMigrations(dir);
  const applied = [];
  const alreadyApplied = [];

  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        text        PRIMARY KEY,
      checksum    text        NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `);

  await db.query("SELECT pg_advisory_lock($1)", [ADVISORY_LOCK_KEY]);
  try {
    const { rows } = await db.query("SELECT name, checksum FROM schema_migrations");
    const seen = new Map(rows.map((r) => [r.name, r.checksum]));

    for (const m of migrations) {
      const previous = seen.get(m.name);

      if (previous !== undefined) {
        // An edited migration means the database and the repo disagree about
        // what the schema is. Refuse loudly rather than pretend.
        if (previous !== m.checksum) {
          throw new Error(
            `migration ${m.name} has changed since it was applied ` +
              `(recorded ${previous.slice(0, 12)}, file ${m.checksum.slice(0, 12)}). ` +
              `Migrations are immutable once applied — add a new one instead.`
          );
        }
        alreadyApplied.push(m.name);
        continue;
      }

      log(`applying ${m.name}`);
      await db.query("BEGIN");
      try {
        await db.query(m.sql);
        await db.query(
          "INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)",
          [m.name, m.checksum]
        );
        await db.query("COMMIT");
      } catch (err) {
        await db.query("ROLLBACK");
        throw new Error(`migration ${m.name} failed: ${err.message}`, { cause: err });
      }
      applied.push(m.name);
    }
  } finally {
    await db.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY]);
  }

  return { applied, alreadyApplied };
}

module.exports = { migrate, loadMigrations, MIGRATIONS_DIR };

// --- CLI: npm run migrate ---
if (require.main === module) {
  const { Pool } = require("pg");
  const { databaseUrl } = require("./config");

  const pool = new Pool({ connectionString: databaseUrl() });
  migrate(pool, { log: (m) => console.log(m) })
    .then(({ applied, alreadyApplied }) => {
      if (applied.length === 0) {
        console.log(`nothing to do — ${alreadyApplied.length} migration(s) already applied`);
      } else {
        console.log(`done: applied ${applied.length}, ${alreadyApplied.length} already up to date`);
      }
      return pool.end();
    })
    .catch(async (err) => {
      console.error(err.message);
      await pool.end();
      process.exit(1);
    });
}
