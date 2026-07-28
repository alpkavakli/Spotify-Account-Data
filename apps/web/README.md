# @lyricsearch/web — hosted service

The multi-tenant SaaS edition. Shares all domain logic with the Personal Edition
through `@lyricsearch/core`; the only differences are the storage adapter
(Postgres instead of SQLite) and the host.

**Status: Phase 1, step 3 of 7.** The database schema and migration runner exist.
The adapter, API, worker and frontend do not yet — see
[`docs/05-PHASE-1-SAAS.md`](../../docs/05-PHASE-1-SAAS.md).

## Getting a database

```bash
npm run db:up      # Postgres 17 in Docker, on port 5433
npm run migrate    # apply migrations/*.sql
npm test           # 45 tests against the real database
npm run db:down    # stop it (data survives in the volume)
```

Port **5433**, not 5432, so it can never collide with a Postgres already
installed on your machine.

Connection string defaults to
`postgres://lyricsearch:lyricsearch@127.0.0.1:5433/lyricsearch`; override with
`DATABASE_URL`. Tests use a **separate** database (`..._test`, plus a per-file
suffix) which they drop and recreate on every run — they must never be pointed at
anything you care about.

## Layout

```
migrations/     forward-only .sql, applied in filename order
src/
  config.js     environment in one place
  migrate.js    the migration runner (~80 lines, no framework)
test/
  migrate.test.js   the runner: ordering, idempotency, rollback, locking
  schema.test.js    the schema: tenant isolation, FTS, cascade deletes, types
```

## The data model

Read [`docs/06-DATA-MODEL.md`](../../docs/06-DATA-MODEL.md) — and
[`migrations/001_init.sql`](migrations/001_init.sql), which is written to be read.

The short version: **songs and lyrics are global, shared by every user**; only
play counts and library membership are per-user. That keeps storage flat and
means LRCLIB is asked about each song exactly once across the whole user base.

## Notes for whoever writes the next step

- **Migrations are immutable once applied.** The runner refuses to start if an
  applied migration's checksum has changed. Add `002_*.sql`; never edit `001`.
- **Tests need a real Postgres.** They skip (with an explanation) rather than
  fail when it is not running, so the root `npm test` stays green for people
  working only on the Personal Edition. If you see `skipped`, run `npm run db:up`.
- **Each test file uses its own database.** `node --test` runs files in parallel
  processes, and these helpers drop and recreate their database — two files
  sharing one name tear down each other's connections mid-test, and the failures
  look like schema bugs.
- **`bigint` comes back from node-postgres as a string.** `ms_played` and
  `spotify_accounts.expires_at` are `int8`. The `StorageAdapter` conformance
  suite requires numbers, so the adapter must cast or register a type parser.
