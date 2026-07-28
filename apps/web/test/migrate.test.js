"use strict";

// Tests for the migration runner itself, separately from the schema it applies.
// A runner that silently re-applies a migration, or silently accepts an edited
// one, is worse than no runner at all.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { migrate, loadMigrations, MIGRATIONS_DIR } = require("../src/migrate");
const { skipWithoutPostgres, emptyDatabase } = require("./helpers/pg");

const tempDirs = [];

/** A throwaway migrations directory, so tests do not depend on the real one. */
function migrationsDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lyricsearch-migrations-"));
  tempDirs.push(dir);
  for (const [name, sql] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), sql);
  }
  return dir;
}

test.after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// ── pure: no database needed ──────────────────────────────────────────────

test.describe("loadMigrations", () => {
  test.it("orders numerically, not lexically", async () => {
    // "10_x.sql" must come after "9_x.sql". Plain string sort gets this wrong,
    // and the failure only appears on the tenth migration — long after anyone
    // is watching for it.
    const dir = migrationsDir({
      "1_a.sql": "SELECT 1;",
      "2_b.sql": "SELECT 1;",
      "10_c.sql": "SELECT 1;",
    });
    assert.deepEqual(
      loadMigrations(dir).map((m) => m.name),
      ["1_a.sql", "2_b.sql", "10_c.sql"]
    );
  });

  test.it("ignores non-SQL files", async () => {
    const dir = migrationsDir({ "001_a.sql": "SELECT 1;", "README.md": "# notes" });
    assert.deepEqual(loadMigrations(dir).map((m) => m.name), ["001_a.sql"]);
  });

  test.it("returns nothing for a directory that does not exist", () => {
    assert.deepEqual(loadMigrations(path.join(os.tmpdir(), "nope-does-not-exist")), []);
  });

  test.it("checksums the contents", () => {
    const a = migrationsDir({ "001.sql": "SELECT 1;" });
    const b = migrationsDir({ "001.sql": "SELECT 1;" });
    const c = migrationsDir({ "001.sql": "SELECT 2;" });
    assert.equal(loadMigrations(a)[0].checksum, loadMigrations(b)[0].checksum);
    assert.notEqual(loadMigrations(a)[0].checksum, loadMigrations(c)[0].checksum);
  });

  test.it("finds the real migrations", () => {
    const real = loadMigrations(MIGRATIONS_DIR);
    assert.ok(real.length >= 1, "expected at least 001_init.sql");
    assert.equal(real[0].name, "001_init.sql");
  });
});

// ── against a real database ───────────────────────────────────────────────

test.describe("migrate", { skip: skipWithoutPostgres() }, () => {
  let pool;

  test.beforeEach(async () => {
    pool = await emptyDatabase("migrate");
  });

  test.afterEach(async () => {
    await pool?.end();
  });

  test.it("applies migrations in order and records them", async () => {
    const dir = migrationsDir({
      "001_a.sql": "CREATE TABLE a (id int);",
      "002_b.sql": "CREATE TABLE b (id int);",
    });

    const result = await migrate(pool, { dir });
    assert.deepEqual(result.applied, ["001_a.sql", "002_b.sql"]);
    assert.deepEqual(result.alreadyApplied, []);

    const { rows } = await pool.query("SELECT name FROM schema_migrations ORDER BY name");
    assert.deepEqual(rows.map((r) => r.name), ["001_a.sql", "002_b.sql"]);
  });

  test.it("is idempotent — running twice applies nothing the second time", async () => {
    const dir = migrationsDir({ "001_a.sql": "CREATE TABLE a (id int);" });

    await migrate(pool, { dir });
    const second = await migrate(pool, { dir });

    assert.deepEqual(second.applied, []);
    assert.deepEqual(second.alreadyApplied, ["001_a.sql"]);
  });

  test.it("applies only the new migration when one is added", async () => {
    const dir = migrationsDir({ "001_a.sql": "CREATE TABLE a (id int);" });
    await migrate(pool, { dir });

    fs.writeFileSync(path.join(dir, "002_b.sql"), "CREATE TABLE b (id int);");
    const result = await migrate(pool, { dir });

    assert.deepEqual(result.applied, ["002_b.sql"]);
    assert.deepEqual(result.alreadyApplied, ["001_a.sql"]);
  });

  test.it("rolls a failed migration back completely", async () => {
    // Postgres has transactional DDL, so a migration that fails halfway must
    // leave NOTHING behind — no orphan table, no recorded version. Otherwise
    // the next run starts from a schema nobody has ever described.
    const dir = migrationsDir({
      "001_bad.sql": "CREATE TABLE ok_so_far (id int); SELECT nonexistent_function();",
    });

    await assert.rejects(() => migrate(pool, { dir }), /001_bad\.sql failed/);

    const { rows } = await pool.query(
      "SELECT to_regclass('public.ok_so_far') AS t, " +
        "(SELECT count(*) FROM schema_migrations) AS c"
    );
    assert.equal(rows[0].t, null, "the half-created table must be gone");
    assert.equal(Number(rows[0].c), 0, "a failed migration must not be recorded");
  });

  test.it("does not apply later migrations after one fails", async () => {
    const dir = migrationsDir({
      "001_bad.sql": "SELECT nonexistent_function();",
      "002_later.sql": "CREATE TABLE later (id int);",
    });

    await assert.rejects(() => migrate(pool, { dir }));
    const { rows } = await pool.query("SELECT to_regclass('public.later') AS t");
    assert.equal(rows[0].t, null);
  });

  test.it("refuses to run when an applied migration has been edited", async () => {
    // The database and the repo would otherwise disagree about what the schema
    // is, with nothing to reveal it. Applied migrations are immutable.
    const dir = migrationsDir({ "001_a.sql": "CREATE TABLE a (id int);" });
    await migrate(pool, { dir });

    fs.writeFileSync(path.join(dir, "001_a.sql"), "CREATE TABLE a (id int, extra text);");

    await assert.rejects(
      () => migrate(pool, { dir }),
      /has changed since it was applied/
    );
  });

  test.it("releases its advisory lock so the next run is not blocked", async () => {
    const dir = migrationsDir({ "001_a.sql": "CREATE TABLE a (id int);" });
    await migrate(pool, { dir });

    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'"
    );
    assert.equal(rows[0].n, 0, "advisory lock still held — a second instance would hang");
  });

  test.it("releases the lock even when a migration fails", async () => {
    const dir = migrationsDir({ "001_bad.sql": "SELECT nonexistent_function();" });
    await assert.rejects(() => migrate(pool, { dir }));

    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'"
    );
    assert.equal(rows[0].n, 0);
  });

  test.it("handles an empty migrations directory", async () => {
    const result = await migrate(pool, { dir: migrationsDir({}) });
    assert.deepEqual(result.applied, []);
  });
});
