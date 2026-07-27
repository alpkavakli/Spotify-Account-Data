# 03 — Phase 0: Extract `core` + `StorageAdapter` (no behavior change)

**Goal:** break the hard-wired SQLite singleton (`require("./db")` used everywhere) so
domain logic becomes a reusable, storage-agnostic `core` package. The Personal Edition
becomes `apps/personal` running on a `SqliteAdapter`; the future SaaS reuses the same
`core` on a `PostgresAdapter`. **No feature or behavior changes in this phase** — it is
a pure restructuring, verified by matching output before and after.

## Target layout (monorepo, npm workspaces)

```
<repo>/
├── package.json                 workspaces: ["packages/*", "apps/*"]
├── packages/core/               PURE logic — no express, no sqlite, no fs
│   └── src/
│       ├── matching.js          normalize, cleanTitle, matchKey
│       ├── ingest.js            parse export JSON → canonical song list (no DB writes)
│       ├── lyrics.js            LRCLIB client + pickBest + classify → {status,source,body}
│       ├── search.js            toFtsQuery, countOccurrences, top-words aggregation
│       ├── spotify.js           OAuth URLs, token exchange/refresh, pickMatch, playlist calls (tokens passed in)
│       └── storage.js           the StorageAdapter contract (JSDoc typedef)
├── apps/personal/               today's app
│   ├── src/
│   │   ├── sqlite-adapter.js    implements StorageAdapter over node:sqlite (schema lives here)
│   │   ├── server.js            Express host — wires core + adapter
│   │   ├── ingest.js            CLI: read files → core.ingest → adapter.upsertSongs
│   │   └── lyrics.js            CLI: adapter.getSongsNeedingLyrics → core.lyrics → adapter.saveLyrics
│   ├── frontend/                moved from top-level Frontend/
│   ├── Dockerfile · README.md
└── docs/ · Data/ (gitignored)
```

## The `StorageAdapter` contract (derived from current SQL)

`core` never touches a database; everything persisted/queried goes through these.
SQLite implements them now; Postgres (multi-tenant, `user_id`-scoped) implements the
same shape later (Liskov). Grouped by concern (Interface Segregation).

| Method | Replaces (current code) |
|--------|-------------------------|
| `upsertSongs(songs)` | the `ON CONFLICT` bulk insert in `ingest.js` (one transaction — Atomicity) |
| `getSongsNeedingLyrics({retryErrors})` | the `LEFT JOIN lyrics ... WHERE NULL` query |
| `saveLyrics(songId, {status,source,body})` | `saveLyrics` + FTS insert/delete in `lyrics.js` |
| `searchByLyrics(ftsQuery)` | the FTS `MATCH` + `snippet()` query in `/searchForWord` |
| `getSong(id)` / `getSongsByIds(ids)` | `/song/:id` and the playlist `IN (...)` query |
| `getStats()` / `getStatus()` | `/stats` and `/status` queries |
| `getLyricRowsForWordCount()` | the `status='ok'` rows feeding `topWords` |
| `getAuth()` / `saveTokens()` / `setAuthUser()` / `clearAuth()` | the `auth` table in `spotify.js` |
| `setSongUri(songId, uri)` | the `UPDATE tracks SET uri` in `resolveUri` |

## Step sequence (each step = one commit; user commits with agent-provided message)

1. **Smoke-test the baseline first** — capture current output of `/searchForWord`,
   `/stats`, `/topWords`, `/status`, `/song/:id` against the existing `spotify.db`, as
   the reference to diff the refactor against. (Spotify OAuth stays untested until
   Phase 2, when the SDA is registered.)
2. **Scaffold workspaces** — root `package.json`, `packages/core`, `apps/personal`;
   move files; keep everything runnable.
3. **Extract pure logic into `core`** (`matching`, `search`, `ingest` merge,
   `lyrics` client) — no DB touched. **`spotify` deferred to Step 5** (its logic
   is entangled with token *storage*, so it becomes clean only once the adapter
   exists — and it's the one piece untestable without Spotify creds).
4. **Write `storage.js`** (contract) + **`sqlite-adapter.js`** (current SQL behind it).
5. **Rewire** `server.js`, `ingest.js`, `lyrics.js` to use `core` + the adapter.
6. **Re-run the same smoke tests** — output must match step 1. Update Dockerfile /
   compose paths.

**Sequencing rule:** step 1 (baseline) must come before any refactor — a
"no behavior change" claim is only trustworthy against a captured baseline.

## Status
- [x] Step 1 — smoke-test baseline (see `10-WORKLOG.md`, 2026-07-27)
- [x] Step 2 — scaffold workspaces (see `10-WORKLOG.md`, 2026-07-27)
- [x] Step 3 — extract `core` (matching, search, ingest, lyrics) (see `10-WORKLOG.md`, 2026-07-27)
- [x] Step 4 — `storage.js` + `sqlite-adapter.js` (see `10-WORKLOG.md`, 2026-07-27)
- [ ] Step 5 — rewire host **+ extract & rewire `spotify`**
- [ ] Step 6 — verify + ops paths

See `10-WORKLOG.md` for actual results as each step completes.
