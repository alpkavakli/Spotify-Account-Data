# @lyricsearch/web — hosted service

The multi-tenant SaaS edition. Shares all domain logic with the Personal Edition
through `@lyricsearch/core`; the only differences are the storage adapter
(Postgres instead of SQLite) and the host.

**Status: Phase 1, step 5 of 7.** Schema, migrations, `PostgresAdapter`,
passwordless accounts, upload intake and the read API all exist. The worker
(which actually parses uploads) and the frontend do not yet — see
[`docs/05-PHASE-1-SAAS.md`](../../docs/05-PHASE-1-SAAS.md).

## Running it

```bash
npm run db:up      # Postgres in Docker
npm start          # migrates, then listens on :3001
```

Sign-in links are **printed to the terminal** by `ConsoleMailer` — click one out
of the log. The server refuses to start with `NODE_ENV=production` until a real
mailer is wired, because a login system that quietly mails to a log file is worse
than one that fails to boot.

```bash
curl -X POST localhost:3001/auth/request-link -H 'content-type: application/json' \
     -d '{"email":"you@example.com"}'
# copy the link from the server log, then:
curl -c jar 'localhost:3001/auth/callback?token=...'
curl -b jar localhost:3001/me
curl -b jar --data-binary @export.zip -H 'content-type: application/zip' \
     'localhost:3001/uploads?filename=export.zip'
```

## API

| Route | Auth | Purpose |
|---|---|---|
| `GET /health` | — | is the database reachable |
| `POST /auth/request-link` | — | email a one-time sign-in link |
| `GET /auth/callback?token=` | — | exchange the link for a session cookie |
| `POST /auth/logout` | — | destroy the session server-side |
| `GET /me` | — | who am I (`{signedIn:false}` when not) |
| `DELETE /me` | ✅ | erase the account (one cascading `DELETE`) |
| `POST /uploads` | ✅ | raw file body → blob store, `202` + queued row |
| `GET /uploads` | ✅ | your uploads and their status |
| `GET /searchForWord?q=` | ✅ | lyric search over your library |
| `GET /song/:id` | ✅ | one song — **snippet only, never full lyrics** |
| `GET /topWords` | ✅ | your most-sung words |
| `GET /stats` | ✅ | totals, top songs/artists, coverage window |
| `GET /status` | ✅ | ingest and lyric-fetch progress |

## Getting a database

```bash
npm run db:up      # Postgres 17 in Docker, on port 5433
npm run migrate    # apply migrations/*.sql
npm test           # 170 tests against the real database
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
  config.js            environment in one place
  migrate.js           the migration runner (~80 lines, no framework)
  postgres-adapter.js  StorageAdapter over pg, scoped to one user
  blob-store.js        BlobStore contract + LocalBlobStore (disk)
  mailer.js            Mailer contract + Console/Memory implementations
  auth.js              passwordless links and sessions (hashed, never raw)
  app.js               the HTTP API, as a factory
  server.js            migrate, wire, listen
test/
  migrate.test.js          the runner: ordering, idempotency, rollback, locking
  schema.test.js           the schema: tenant isolation, FTS, cascades, types
  postgres-adapter.test.js the shared conformance suite + multi-tenancy
  blob-store.test.js       round-trips, key generation, path traversal
  api.test.js              the API end-to-end, incl. cross-tenant isolation
```

## The adapter

`new PostgresAdapter(pool, { userId })` — **every instance is scoped to one
user**, and the constructor throws without one. Tenant isolation lives in that
file and nowhere else: no route writes SQL, so reading another user's data would
take a bug in the adapter rather than a forgotten `WHERE`.

It passes `@lyricsearch/core/testing/adapter-conformance` — the identical suite
`SqliteAdapter` passes. That is what lets `core` and the routes hold either one.

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
- **`bigint` comes back from node-postgres as a string.** Handled in
  `postgres-adapter.js` with `setTypeParser(INT8, Number)` plus `::float8` on
  aggregates (`SUM()` over integers returns `numeric`, also stringified). If you
  add a query returning an int8, check what type it arrives as.
- **`fixtures.seed()` works once per database.** It learns ids from
  `getSongsNeedingLyrics()`, which correctly returns nothing for a second tenant
  because lyrics are global. A second tenant should `upsertSongs(SONGS)`.
