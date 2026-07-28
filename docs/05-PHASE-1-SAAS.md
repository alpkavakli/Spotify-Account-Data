# 05 — Phase 1: SaaS core on Postgres (no Spotify)

**Goal:** a multi-tenant hosted service that is fully useful with **zero Spotify
dependency** — upload your export, search your songs by lyric, see stats. Accounts,
Postgres, background jobs. Spotify connect and playlist creation are Phase 2.

This is deliberately the lowest-risk phase: nothing here needs Spotify Extended
Access, so none of it can be blocked by Spotify's review.

**Non-goal:** changing `packages/core`. If a step requires editing `core` to make
Postgres work, the abstraction is wrong — fix the abstraction, not `core`.

## Target layout (added to the existing monorepo)

```
packages/core/                 UNCHANGED (+ testing/ conformance suite)
apps/personal/                 UNCHANGED behavior (SqliteAdapter)
apps/web/                      NEW — the hosted service
├── src/
│   ├── postgres-adapter.js    StorageAdapter over pg, user_id-scoped
│   ├── blob-store.js          BlobStore contract + LocalBlobStore
│   ├── app.js                 HTTP API (same factory pattern as personal)
│   └── worker.js              pg-boss consumers (ingest, lyric fetch)
├── migrations/                versioned SQL, forward-only
└── test/
```

## Step sequence (each step = one commit; the user commits)

1. **Test suite + testable app factory** — the safety net, built before anything
   moves. Includes the shared adapter conformance suite. ✅
2. **Async `StorageAdapter`** — every contract method returns a Promise;
   `SqliteAdapter` methods become `async`; hosts `await`. Required because `pg` is
   Promise-based and a synchronous contract is unimplementable on Postgres. The
   Step-1 suite is what proves the Personal Edition's behavior is unchanged.
3. **Postgres schema + migrations** — the multi-tenant model from
   `PROJECT_PLAN.md §7`: global `songs` + `lyrics` (shared by everyone, fetched
   once), per-user `user_songs`, plus `users` and `sessions`. Runnable via
   docker-compose.
4. **`PostgresAdapter`** — implements the same contract, scoped to a `user_id`,
   and **passes the same conformance suite** as `SqliteAdapter`. Postgres FTS
   (`tsvector` + `ts_headline`) has to reproduce the stemming and the `[[ ]]`
   snippet markers the suite asserts.
5. **`apps/web` API + accounts + upload intake** — email/passwordless accounts,
   sessions, upload of an export `.zip` to a `BlobStore` (local disk now, S3/R2
   later behind the same interface), and the read routes on top of
   `PostgresAdapter`.
6. **Worker (pg-boss)** — parse-upload and fetch-lyrics jobs. Lyric fetch is
   **global, not per-user**: a song's lyrics are the same for everybody, so it is
   fetched once and every user benefits. This is also what keeps LRCLIB load flat
   as the user base grows.
7. **Next.js frontend** — SSR for SEO (the service is ad-supported, so organic
   traffic is the business model). The Personal Edition keeps its static HTML.

## Rules held throughout

- **`core` does not change.** New behavior arrives as a new adapter (Open/Closed).
- **Every adapter passes the conformance suite** before anything is built on it
  (Liskov, enforced by test — see `04-TESTING.md`).
- **Multi-tenancy is not a filter you remember to apply.** Every `user_songs`
  query is scoped by `user_id` inside the adapter; no route can forget it,
  because no route writes SQL.
- **Lyrics are stored once, globally.** Per-user tables hold only "which songs
  this user has, and how often they played them".
- **The user makes every commit.** The agent supplies commit-message text only.

## Status

- [x] Step 1 — test suite + `createApp` factory (see `10-WORKLOG.md`, 2026-07-27)
- [x] Step 2 — async `StorageAdapter` (see `10-WORKLOG.md`, 2026-07-27)
- [x] Step 3 — Postgres schema + migrations (see `10-WORKLOG.md`, 2026-07-28; model documented in `06-DATA-MODEL.md`)
- [x] Step 4 — `PostgresAdapter` passing the conformance suite (see `10-WORKLOG.md`, 2026-07-28)
- [ ] Step 5 — `apps/web` API + accounts + upload intake
- [ ] Step 6 — pg-boss worker
- [ ] Step 7 — Next.js frontend
