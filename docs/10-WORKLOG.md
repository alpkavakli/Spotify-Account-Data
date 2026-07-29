# 10 — Worklog (append-only)

Running record of what we actually did. Newest entries at the bottom. See
`00-INDEX.md` for how these docs fit together.

---

## 2026-07-27 — Phase 0, Step 1: smoke-test the baseline ✅

**Why:** capture the current app's exact behavior *before* refactoring, so the
"no behavior change" claim can be verified by diffing after.

**Environment:** Node v24.14.0, npm 11.9.0. `Backend/node_modules` present.
Existing populated `Data/spotify.db` (7.9 MB). Server started with `node src/server.js`
on `http://127.0.0.1:3000` (Spotify creds not set → playlist creation disabled, as
expected; auth endpoints untested until Phase 2).

**What we did:** probed every read endpoint and saved full JSON responses as the
reference baseline (scratchpad `baseline/` + summarized here). Then stopped the server.

**Baseline reference values** (must match after the refactor):

| Endpoint | Key values |
|----------|-----------|
| `/status` | `tracks=4044, processed=4044, lyrics: ok=3714 instrumental=144 notfound=186` |
| `/stats` | `tracks=4044 artists=1692 plays=22013 hours=1035`; top song = The Strokes – Ode To The Mets (221 plays); top artist = No Clear Mind (24 songs, 648 plays) |
| `/topWords?limit=25` | `songsWithLyrics=3714`; first 5 = know(1198), like(1166), love(1033), now(971), time(902) |
| `/searchForWord?q=door` | `count=154`; r0 = The Strokes – Ode To The Mets (occ=1) |
| `/searchForWord?q=love` | `count=1125`; r0 = No Clear Mind – Big Thing (occ=3) |
| `/searchForWord?q=heart fire` | `count=45`; r0 = Iyeoka – Simply Falling (occ=13) |
| `/song/1` | Emile Pandolfi – Once Upon a December (playCount=11, 33 min) |
| `/me` | `configured=false, loggedIn=false` (no Spotify creds) |

**sha256 fingerprints (first 16 hex) of saved responses** — for exact-match diffing.
Ordering is deterministic on a fixed DB (search: `play_count DESC, artist, track`;
topWords: insertion-order Map), so these should reproduce byte-for-byte after the
refactor:

```
status.json          4b313502803f441c
stats.json           64b27b91a6620b0d
topWords.json        836d68b9328ac39d
search_door.json     5d38742adb0431a3
search_love.json     c17047d4f9dfe3c3
search_heart_fire.json 32605375ea474dd1
song_1.json          e754876ba104f758
me.json              30893b0e11628623
```

Baseline files saved at (scratchpad, ephemeral):
`.../scratchpad/baseline/*.json`

**Result:** ✅ Baseline captured. All read endpoints work against the real DB. Ready
for Step 2 (scaffold workspaces).

**Note for verification:** after the refactor, re-run the same requests and compare
sha256s. If ordering-sensitive files differ, diff the JSON to confirm the delta is
only ordering vs. a real behavior change.

---

## 2026-07-27 — Phase 0, Step 2: scaffold monorepo + relocate app ✅

**Why:** turn the flat `Backend/` + `Frontend/` layout into an npm-workspaces
monorepo so `core` (Step 3) can be a real shared package. Pure relocation — no
domain-logic changes.

**What we did:**
- Created workspace root `package.json` (`"private": true`, `workspaces: ["packages/*","apps/*"]`, engines node>=24, convenience scripts that delegate to the personal app).
- Created `packages/core/` (package `@lyricsearch/core`, `src/index.js` placeholder exporting `{}` — filled in Step 3).
- Moved the app into `apps/personal/` (`@lyricsearch/personal`):
  - `Backend/src` → `apps/personal/src`
  - `Frontend/` → `apps/personal/frontend` (lowercased)
  - `Data/` → `apps/personal/Data` (real export + `spotify.db` moved with it; git-ignored)
  - `Backend/.env.example`, `docker-entrypoint.sh` → `apps/personal/`
  - `Dockerfile`, `docker-compose.yml`, `.dockerignore` → `apps/personal/` (**NOT yet rewritten — see Step 6**)
- Adjusted relative-path defaults for the new depth (mechanical, not behavioral):
  `db.js` `DATA_DIR` and `ingest.js` `EXPORT_DIR` `../../Data` → `../Data`;
  `server.js` static `../../Frontend` → `../frontend`. The dotenv path `../.env` was
  already correct.
- `.gitignore`: root Data rule re-pointed to `apps/personal/Data/*`; added a
  self-contained `apps/personal/.gitignore` (travels with the future public split).
- Removed `Backend/package.json`, `package-lock.json`, `node_modules`. Seeded the old
  lockfile at root and ran `npm install` → workspace-aware lockfile + hoisted
  `node_modules` (71 packages, 0 vulnerabilities).

**Verification:** started via root `npm start` (delegates to `@lyricsearch/personal`),
found the relocated DB, re-ran all 8 baseline requests. **All 8 sha256s matched the
Step-1 baseline byte-for-byte.** ✅ No behavior change.

**Known leftovers / deferred:**
- `Backend/.claude/settings.local.json` could not be removed (safety classifier blocks
  deleting `.claude` paths). It is git-ignored and inert (active Claude config is at
  repo root). **User can delete the now-empty `Backend/` folder manually.**
- Docker files were relocated but **not corrected** — they still reference the old
  `Backend/`/`Frontend/` layout and were never built. Rewriting them is **Step 6**,
  after `core` extraction settles the final layout.
- `ejs` is still a dependency but appears unused (server serves static files). Leave
  for now; prune in a later cleanup.

**Result:** ✅ Monorepo scaffolded, app runs identically from `apps/personal`. Ready
for Step 3 (extract `core`).

---

## 2026-07-27 — Phase 0, Step 3: extract `core` (matching, search, ingest, lyrics) ✅

**Why:** move the storage-/HTTP-agnostic domain logic into `@lyricsearch/core` so
both editions can share it (Dependency Inversion). `apps/personal` keeps only the
SQLite + Express glue.

**Scope decision:** extracted the four modules verifiable without Spotify creds and
rewired the app to use them. **`spotify` intentionally deferred to Step 5** — its
pure logic is tangled with token storage, so it only becomes clean once the
`StorageAdapter` exists, and it can't be tested end-to-end without creds. Shipping it
half-decoupled and untested would be a step backwards.

**What we did:**
- Created `packages/core/src/`:
  - `matching.js` — `normalize`, `cleanTitle`, `matchKey` (verbatim).
  - `search.js` — `toFtsQuery`, `countOccurrences`, `STOPWORDS`, and a pure
    `aggregateTopWords(rows, limit)`.
  - `ingest.js` — pure `buildSongs({library, playlists, histories})` → canonical song
    list + stats. No fs, no DB.
  - `lyrics.js` — LRCLIB client (`searchLrclib` w/ backoff, `pickBest`) + a
    `fetchLyrics(artist, track)` → `{status, source, body}`. No DB.
  - `index.js` namespaces the four; `package.json` adds a subpath `exports` map so
    consumers import narrowly, e.g. `require("@lyricsearch/core/matching")`
    (Interface Segregation).
- Rewired `apps/personal`:
  - `db.js` → pure database (dropped the matching functions; exports `{db, DATA_DIR}`).
  - `ingest.js` → reads files (fs) + writes DB in one transaction, merge via
    `core.buildSongs`.
  - `lyrics.js` → keeps DB persistence + concurrency + politeness delay, fetch via
    `core.fetchLyrics`.
  - `server.js` → search endpoints + top-words use `core.search`.
  - `spotify.js` → import line only: matching now from `core` (rest untouched).
  - `apps/personal/package.json` → depends on `@lyricsearch/core` (`"*"`); `npm install`
    symlinked the workspace.

**Verification (all green):**
1. **HTTP baseline** — restarted server, re-ran all 8 endpoints: **all 8 sha256s match
   the Step-1 baseline byte-for-byte.** (covers matching + search + stats + top-words)
2. **Ingest** — ran the new ingest against a *temp copy* of the export
   (`4044 unique songs`) and compared the `tracks` table to the real DB row-for-row:
   **identical hash `a1d01b0f…`, same IDs.** (real DB never touched)
3. **Lyrics CLI** — ran on the real DB: `nothing to fetch — all tracks processed`,
   `ok=3714 instrumental=144 notfound=186`. Wiring intact.
4. **Live client** — `core.fetchLyrics("The Strokes", "Ode To The Mets - 2020 Remaster")`
   → `status: ok, source: lrclib, 1412 chars` ("Up on his horse…"). Extracted LRCLIB
   client works against the network.
5. **Grep** — no stale references to moved functions; all resolve to `core`.

**Result:** ✅ `core` now owns matching/search/ingest/lyrics; app behavior unchanged.
Ready for Step 4 (`StorageAdapter` interface + `SqliteAdapter`).

---

## 2026-07-27 — Phase 0, Step 4: `StorageAdapter` contract + `SqliteAdapter` ✅

**Why:** put all persistence behind one abstraction so `core`/hosts never depend on a
concrete DB (Dependency Inversion), and both editions' adapters are interchangeable
(Liskov). This sets up Step 5, where the host stops touching SQL directly.

**What we did:**
- `packages/core/src/storage.js` — the `StorageAdapter` base class: JSDoc typedefs
  for row shapes + method stubs that throw `"...not implemented"` (fail-loud). Methods
  grouped by concern: ingest / search+read / lyrics / spotify-auth / lifecycle
  (Interface Segregation). Added to `index.js` and the `exports` map (`./storage`).
- `apps/personal/src/sqlite-adapter.js` — `SqliteAdapter extends StorageAdapter`,
  owns the `DatabaseSync` connection, WAL/FK pragmas, and the full schema (tracks,
  lyrics, FTS5, auth — auth was previously created in `spotify.js`). Implements every
  method by relocating the exact SQL from `db.js`/`server.js`/`ingest.js`/`lyrics.js`/
  `spotify.js`. `upsertSongs` wraps its loop in BEGIN/COMMIT with ROLLBACK on error
  (Atomicity). Constructor takes `(dataDir, {readOnly})` so reads can run against the
  real DB without risk.
- **Host NOT rewired yet** — the app still runs on the old direct-SQL `db.js` path.
  The adapter is new and, until Step 5, unused by the running app. To avoid shipping
  unverified "dead" code, it was tested independently (below).

**Verification — 12/12 green** (scratchpad `adapter_test.js`):
- **7 read methods:** rebuilt each HTTP response (`/searchForWord` ×3, `/stats`,
  `/status`, `/topWords`, `/song/1`) from `adapter + core` exactly as the Step-5 host
  will, and compared to the Step-1 baseline → **all 7 byte-for-byte identical.** This
  proves the upcoming host swap changes nothing.
- **upsertSongs:** ran against a temp copy → `tracks` table **identical to the real DB
  row-for-row** (same hash + IDs).
- **saveLyrics:** persisted + FTS-indexed + searchable, snippet highlighted `[[doorway]]`.
- **setSongUri:** persisted. **auth:** saveTokens+setAuthUser round-trip, clearAuth → null.
- **Running app unchanged:** started `server.js`, `/status` = 4044/4044, `door` = 154.

**Result:** ✅ Adapter fully implemented and independently verified. Step 5 can swap the
host onto it with high confidence, and extract Spotify at the same time.

---

## 2026-07-27 — Phase 0, Step 5: rewire host onto adapter + extract Spotify ✅

**Why:** finish the extraction — the host stops touching SQL entirely and depends only
on the `StorageAdapter`; Spotify's HTTP/OAuth logic moves into `core` while its token
*storage* goes through the adapter. This completes the shared-core architecture.

**What we did:**
- **`packages/core/src/spotify.js`** — stateless Spotify client: `authorizeUrl`,
  `exchangeCode`, `refreshAccessToken`, `getMe`, `apiFetch` (429 backoff / 401→NO_AUTH),
  `pickMatch`, `searchTrackUri` (returns uri|null, no DB), `createPlaylist`, `addTracks`.
  Every call takes credentials/token as arguments — no env, no DB, no token storage.
  Added to `index.js` + `exports` map (`./spotify`).
- **`apps/personal/src/store.js`** — the single `SqliteAdapter` instance (replaces the
  old `db.js` singleton); owns the `DATA_DIR` resolution.
- **`apps/personal/src/spotify.js`** — reduced to thin glue: creds from env, tokens via
  `store` (getAuth/saveTokens/setAuthUser/clearAuth/setSongUri), all HTTP delegated to
  `core.spotify`. Same public surface + error codes (NO_AUTH / NO_CREDENTIALS) as before.
- **Rewired hosts** to `store`: `server.js` (all 6 read routes + createPlaylist),
  `ingest.js` (`store.upsertSongs`), `lyrics.js` (`getSongsNeedingLyrics` / `saveLyrics`
  / `getLyricStatusCounts`).
- **Deleted `apps/personal/src/db.js`.** All SQL now lives only in `sqlite-adapter.js`.
- Fixed two stale user-facing messages (`Backend/.env` → `apps/personal/.env`).

**Behavior-preservation note (Spotify):** the OAuth network flow stays untestable until
Phase 2 (no creds). The glue keeps the original structure; one intentional change is that
a token is fetched once per host operation and passed into `core` (the old code fetched it
inside each `apiFetch`). For the short call bursts here (resolve URIs → create → add) this
is equivalent; documented so it isn't mistaken for a regression.

**Verification — all green:**
1. **HTTP baseline** — all 8 endpoints **byte-for-byte identical** to Step-1 baseline.
2. **Spotify glue (no creds)** — `/login`→503, `/createPlaylist` (no session)→401
   `"not logged in"`, `/logout`→`{ok:true}`. Exercises `store` auth methods.
3. **Adapter suite** — 12/12 still pass.
4. **Ingest CLI** (now `store.upsertSongs`) — temp copy `tracks` **identical to real DB**.
5. **Lyrics CLI** — `nothing to fetch`, `ok=3714 instrumental=144 notfound=186`.
6. **core.spotify unit** — `authorizeUrl` output **matches the original byte-for-byte**;
   `pickMatch` picks the exact match; all 8 exports present.

**Result:** ✅ Host depends only on the adapter; Spotify extracted; `db.js` gone. The
Phase 0 architecture (shared `core` + storage adapter) is in place. Only Step 6 (Docker/
ops) remains.

---

## 2026-07-27 — Phase 0, Step 6: Docker/compose rewrite + ops paths ✅ (Phase 0 COMPLETE)

**Why:** the ops files were relocated in Step 2 but still referenced the old
`Backend/`/`Frontend/` layout and had never been built. Make them monorepo-correct and
actually verify a build+run.

**What we did:**
- **`apps/personal/Dockerfile`** — rewritten for npm workspaces: build context = repo
  root; copy `package.json` + `package-lock.json` + both workspace manifests, `npm ci
  --omit=dev` (links the `core` workspace), then copy `packages/core` + `apps/personal`.
  `DATA_DIR`/`EXPORT_DIR=/data`; WORKDIR `/app/apps/personal`.
- **`apps/personal/docker-compose.yml`** — `build.context: ../..`,
  `dockerfile: apps/personal/Dockerfile`; `env_file: .env` (optional);
  volume `./Data:/data`.
- **`apps/personal/docker-entrypoint.sh`** — paths updated (`/app/apps/personal/.env`,
  ingest from `/data`).
- **`.dockerignore`** — moved to the **repo root** (Docker reads it from the build-context
  root, which is now the repo root, not `apps/personal/`); globbed for `**/Data`, `**/*.db`,
  `**/node_modules`, `**/.env`.
- **`apps/personal/.env.example`** + **root `README.md`** — refreshed for the monorepo
  (paths, quick-start from repo root, Docker from `apps/personal/`, new project-structure
  tree).

**Verification (Docker built + run for the FIRST time):**
- `sh -n` entrypoint: OK. `docker compose config`: context → repo root, `Data` → `/data`,
  `env_file` optional accepted (Compose v5).
- `docker compose build`: **image built successfully** (`personal-app:latest`).
- `docker compose up -d` → container served `/status` = `4044/4044` and
  `/searchForWord?q=door` = `154`, then `docker compose down`. Host DB untouched
  (spotify.db + wal/shm intact). `.env` is created inside the image only, never on the host.

**Result:** ✅ **Phase 0 COMPLETE.** The single-user app is now a monorepo with a shared,
storage-agnostic `@lyricsearch/core` and a `StorageAdapter`; the Personal Edition runs on
`SqliteAdapter` (local + Docker, both verified). Nothing in `core` or the routes will
change when the SaaS adds a `PostgresAdapter`.

**Phase 0 scorecard — behavior preserved throughout:** every step re-verified all 8
baseline endpoints byte-for-byte; ingest reproduces the `tracks` table exactly; adapter
suite 12/12; live lyrics + Spotify-client unit checks green. Only the Spotify OAuth
*network* flow remains untested (needs creds — Phase 2).

**Next: Phase 1** — SaaS core on Postgres (multi-tenant): a `PostgresAdapter`
implementing the same `StorageAdapter`, upload intake, accounts. No `core` changes.

---

## 2026-07-27 — Phase 1, Step 1: test suite + a testable Express app ✅

**Why:** the repo had **zero committed tests** (Phase 0's "adapter suite 12/12" was a
throwaway scratchpad script). Phase 1 adds a second storage backend, a second host and
a job queue — building that on an untested base means every future change is verified
by hand, forever. The user also asked to be shown how Express testing works rather than
being handed tests to maintain blind, so `docs/04-TESTING.md` is written as a guide.

**Decisions taken this step** (see the questions asked at the top of the Phase 1 chat):
1. **Convert `StorageAdapter` to async** (Step 2) — `pg` is Promise-based, so a
   synchronous contract cannot be implemented by Postgres and Liskov breaks on day one.
2. **Tests before Postgres** — build the safety net first, then change things under it.
3. **Uploads to a local disk volume** behind a `BlobStore` seam (S3/R2 later is a new
   class, not a rewrite).

### What we did

**Made the app testable — `apps/personal/src/app.js` (new).**
`server.js` did everything at import time: `require("./store")` opened the real
`Data/spotify.db`, and `app.listen()` bound port 3000. A test could not import it at
all. Extracted `createApp({ store, spotify })`, which builds nothing at import time;
`server.js` is now composition + listen, ~20 lines. Same Dependency-Inversion move as
`StorageAdapter`, one level up — and the seam `apps/web` will reuse.

*Latent bug fixed on the way:* the `/topWords` cache was a module-level `let`, shared by
every app in the process. Harmless single-user; a cross-tenant data leak the moment the
SaaS has more than one user. It now lives inside the factory closure.

**The conformance suite — `packages/core/testing/adapter-conformance.js` (new).**
The executable form of the `StorageAdapter` contract, exported as
`@lyricsearch/core/testing/adapter-conformance`. One call runs ~45 tests over merge
semantics, transaction atomicity, search ordering + stemming, snippet markers, index
cleanup when lyrics stop being `ok`, return **types**, and the auth lifecycle.
`PostgresAdapter` will get the same one-line call in Step 4 — that is what turns the
Liskov commitment in `01-DECISIONS.md` from a promise into a test.

Deliberately asserts value *types*, not just values: `node-postgres` returns `COUNT(*)`
as a **string** by default and the routes do arithmetic on those fields, so
`typeof totals.plays === "number"` is a real portability constraint, pre-registered.

Shared fixtures in `packages/core/testing/fixtures.js`: six songs covering
ok / instrumental / notfound / never-fetched, a plural-only lyric body (proves
stemming), and a song with no "door" (proves exclusion). Lyric bodies are **invented
for this repo** — no real lyrics in fixtures.

**Tests written (210 total, whole suite < 5 s, zero new dependencies — Node 24's
built-in `node:test`):**

| File | Tests | Covers |
|------|-------|--------|
| `core/test/matching.test.js` | 16 | normalize / cleanTitle / matchKey — accents, punctuation, non-Latin, remaster suffixes, the never-empty-title rule |
| `core/test/search.test.js` | 26 | toFtsQuery (operator + quote neutralisation), countOccurrences (stemming, regex-metachar safety), aggregateTopWords |
| `core/test/ingest.test.js` | 17 | the three-source merge, spelling-variant collapse, keep-first album/uri, malformed-row tolerance |
| `core/test/lyrics.test.js` | 24 | LRCLIB client with `fetch` mocked: 404-as-empty, 429/503/network retry, retry exhaustion, fail-fast on 4xx, pickBest scoring, all four statuses |
| `core/test/spotify.test.js` | 27 | exact request shapes (Basic auth, form bodies, scopes), 401→NO_AUTH, 429 Retry-After, 204→null, pickMatch threshold, 100-URI batching |
| `personal/test/sqlite-adapter.test.js` | 51 | the conformance suite + SQLite-specific: WAL mode, FK enforcement, FTS syntax errors, read-only mode |
| `personal/test/routes.test.js` | 44 | all 10 HTTP routes end-to-end, real server + real SQLite |

**Express testing technique** (the thing the user asked to be taught): `app.listen(0)`
binds a real server to a random free port, so tests make real HTTP requests through the
full stack — no `req`/`res` mocking. `test/helpers/http.js` is that in ~40 lines using
Node's built-in `fetch` (what supertest does, not worth a dependency).
`redirect: "manual"` is essential: `/login` 302s to `accounts.spotify.com`, and a
following client would fire real requests at Spotify from the test suite.
`test/helpers/fake-spotify.js` records calls and lets any method be overridden, which is
how `/createPlaylist` gets all seven outcomes (200 / 200-with-missing / 400×3 / 401×2 /
422 / 502) covered with no Spotify account.
`test/helpers/temp-store.js` guarantees no test can ever open the real `Data/spotify.db`.

### Two things the tests found immediately

1. **`core/lyrics.js` `pickBest` comment was wrong.** It said "require at least a
   partial match on both fields", but the threshold is `>= 4`, so *one exact field
   alone* passes. That turns out to be correct and necessary — `fetchLyrics` retries
   with an artist-less search, whose results can never match on artist, so a stricter
   rule would make the fallback dead code. Behavior unchanged; **comment corrected** to
   state the real rule and contrast it with `spotify.pickMatch` (`>= 6`).
2. **SQLite only parses an FTS match expression once the index has rows.** With an
   empty `lyrics_fts`, `"unterminated`, `AND` and `(unbalanced` all return zero rows
   instead of raising. The first version of that test asserted a throw on an empty
   store and failed. Documented in the test — it matters because the `/searchForWord`
   400-handler looks dead until the DB has content.

### Verification

- `npm test` from the repo root: **210 pass, 0 fail** (core 110, personal 100).
- Real server re-checked against the Phase 0 Step-1 baseline on the real
  `spotify.db`: `/status` `4044/4044` `ok=3714 instrumental=144 notfound=186`,
  `/searchForWord?q=door` **154** results, `/stats` `4044 tracks / 1692 artists /
  22013 plays / 1035 hours`, `/topWords` `know(1198) like(1166) love(1033)`,
  `/me` `configured:false`. **All identical** — the `createApp` split changed nothing.

**Result:** ✅ safety net in place before anything moves. `docs/04-TESTING.md` documents
the three layers, the Express technique, and the rules for adding tests.

**Next: Phase 1, Step 2** — convert the `StorageAdapter` contract to async so Postgres
can implement it. The suite above is what proves that conversion changes no behavior.

---

## 2026-07-27 — Phase 1, Step 2: async `StorageAdapter` contract ✅

**Why:** `node:sqlite` is synchronous, so the Phase 0 contract was synchronous. `pg` is
Promise-based — a `PostgresAdapter` **cannot** implement a synchronous contract. Left
alone, Phase 1 would have needed either two contracts (and two route layers that drift
apart, undoing Phase 0) or a pointless async wrapper class. Converting the one contract
is the only option that keeps `SqliteAdapter` and `PostgresAdapter` interchangeable.

Decided in the Phase 1 opening questions; done **second**, so the Step-1 suite is
already in place to prove it changes nothing.

**What we did:**
- **`packages/core/src/storage.js`** — all 17 contract methods are now `async`. Header
  documents *why* the cost (one already-resolved promise per SQLite call) is worth it.
- **`apps/personal/src/sqlite-adapter.js`** — all 17 methods marked `async`. The bodies
  are untouched: node:sqlite still runs inline, so there is no thread hop and no added
  latency, only the shape callers need in order to be able to hold a Postgres adapter.
- **`apps/personal/src/app.js`** — the six read routes and `/me`, `/logout`,
  `/createPlaylist` became `async` handlers; every store call is awaited. `topWords()`
  is async. (`/searchForWord`'s `try/catch` now wraps an `await`, which is what keeps
  its 400-on-bad-query behavior.)
- **`apps/personal/src/spotify.js`** — `session()` and `logout()` are async;
  `saveTokens`/`setAuthUser`/`clearAuth`/`setSongUri` awaited.
- **CLIs** — `ingest.js` gained an async `main()`; `lyrics.js` awaits `saveLyrics`,
  `getSongsNeedingLyrics` and `printStats`.
- **Tests** — `fake-spotify` matches the new async `session()`/`logout()`; the FTS
  syntax-error test moved from `assert.throws` to `assert.rejects`. **The conformance
  suite needed no changes at all** — it was written `await`-everywhere from the start
  precisely so it would hold across this conversion.

**Verification — nothing changed:**
1. **`npm test`: 210 pass, 0 fail** (core 110, personal 100) — same suite, unmodified
   assertions, before and after.
2. **All 8 read endpoints on the real `spotify.db`, identical to the Phase 0 baseline:**
   `/status` `4044/4044 ok=3714 instrumental=144 notfound=186`; `/searchForWord?q=door`
   **154**; `/stats` `4044 / 1692 / 22013 / 1035h`; `/topWords` `know(1198) like(1166)
   love(1033)`; `/song/676` unchanged; `/me` `configured:false`; `/login` **503**;
   `/createPlaylist` **401 "not logged in"**; `/logout` `{ok:true}`.
3. **Ingest CLI** — re-ingested the real export into a temp DB: `4044` rows, `tracks`
   table **byte-identical** to the real database (all 9 columns, ordered by `match_key`).
4. **Lyrics CLI** — `nothing to fetch — all tracks processed`,
   `instrumental=144 notfound=186 ok=3714`.

**Result:** ✅ one async contract, both hosts on it, zero behavior change. The
`StorageAdapter` seam is now genuinely implementable by Postgres.

**Next: Phase 1, Step 3** — Postgres schema + migrations (global `songs`/`lyrics`,
per-user `user_songs`, `users`, `sessions`), runnable from docker-compose.

---

## 2026-07-28 — Stats accuracy: plays vs listens, 12-month export disclosure ✅

**Why:** `WARNINGS.md` reported that "Habibi" was missing from the top-listened
songs despite 800+ historical plays, and asked whether the fault was Spotify's data
or our calculations.

### Investigation (the complaint was NOT a bug)

The streaming history in `apps/personal/Data/` spans **exactly 366 days**
(2025-04-16 → 2026-04-17, 22 236 rows over 3 files). Spotify's standard
**"Account data"** package contains only the **last 12 months**; the 800+ plays
happened before that window and are simply absent from the files. In the window
that does exist, Habibi is counted correctly — 61 rows in the JSON, ranking **#30
of 4044** by listening time, against a top-25 list. It missed the cutoff by about
20 minutes of listening.

The fix is to request Spotify's **"Extended streaming history"** (same privacy
page, up to ~30 days, covers the whole account, different filenames and field
names). So the work below is: read that format, make the counting honest, and
never again let the UI imply the numbers are all-time.

### Two real defects found while investigating

1. **0 ms rows were silently dropped from every counter.** `core/ingest.js` used
   `if (extra.ms_played)` — falsy on `0`. Exactly **223** of 22 236 rows have
   `msPlayed: 0`, and `22236 − 223 = 22013`, which is precisely what `/stats`
   reported. Excluding them is right (queued, never started) but it was an
   accident of truthiness, not a decision, and it was invisible.
2. **Skips counted as full plays.** 4510 of 22 013 plays (**20.5 %**) last under
   30 s. `play_count` therefore flattered songs the user keeps skipping past.

### What we did

**`core/ingest.js`**
- **Explicit 0 ms handling.** A 0 ms row is never a play, and the count of ignored
  rows is reported. The song itself is still recorded — it appeared in your
  history, so it stays searchable; dropping it outright would have silently
  shrunk the library from 4044 to 4012 (caught by re-ingesting the real export
  and noticing the number move).
- **`stream_count` alongside `play_count`.** `play_count` = every play over 0 ms,
  skips included. `stream_count` = plays at or over the skip threshold. Both are
  kept per song; the difference is skips.
- **Configurable threshold**, `skipThresholdMs`, default **30 000** (Spotify's own
  rule — what Wrapped counts and what pays a royalty). Host reads
  `SKIP_THRESHOLD_SECONDS` from `.env`.
- **Extended-history support.** New `normalizePlay()` reads both export shapes:
  `{endTime, artistName, trackName, msPlayed}` and `{ts, ms_played,
  master_metadata_*, spotify_track_uri}`. Podcast/audiobook rows (all
  `master_metadata_*` null) are counted as unusable rather than crashing.
  Bonus: extended rows carry a **track URI on every row**, where the account-data
  export has none at all — that directly reduces the Spotify lookups playlist
  creation has to do.
- **Coverage window.** `stats.historyFrom` / `historyTo`, normalised across both
  timestamp formats, so the UI can state the real period instead of a hardcoded
  "12 months" that would be wrong the moment extended history arrives.

**Storage contract + `SqliteAdapter`**
- `tracks.stream_count` column, exposed through `searchByLyrics`, `getSong` and
  `getStats` (totals, topSongs, topArtists).
- New `meta` key/value table + `getMeta()` / `setMeta()` on the contract — dataset
  facts rather than song facts (coverage window, threshold, source, ingest time).
  The SaaS will want the same thing per tenant.
- **A real migration.** `CREATE TABLE IF NOT EXISTS` does nothing to an existing
  table, so `#migrate()` checks `PRAGMA table_info` and `ALTER TABLE`s the new
  column in. Verified against the real 7.9 MB database: 4044 tracks and all 4044
  lyric rows survived untouched.

**Host + UI**
- `ingest.js` discovers **both** history filename patterns
  (`StreamingHistory_music_N.json` and `Streaming_History_Audio_*.json`, excluding
  the video/podcast files), and prints plays / listens / skips / ignored rows /
  coverage window — plus an explicit warning when the export is account-data only.
- `/stats` gained `streams`, per-row `streams`, and a `coverage` object
  (`from`, `to`, `source`, `skipThresholdSeconds`, `ingestedAt`).
  `/searchForWord` and `/song/:id` gained `streamCount`.
- **The stats page now states its own limits**: "Counts cover 2025-04-16 →
  2026-04-17. A play counts as a listen from 30s." plus, for account-data
  exports, a highlighted note that anything before the start date is missing and
  how to get the rest. Search results show "played 221× (202 listens)" when the
  two differ.

**Docs:** `apps/personal/Data/README.md` rewritten around the two-package
comparison table and the 12-month cap (it also still said "From the `Backend/`
folder", stale since Phase 0 Step 2); root `README.md` gained a prominent
warning section; `.env.example` documents `SKIP_THRESHOLD_SECONDS`.

### Verification

- **`npm test`: 244 pass, 0 fail** (core 132, personal 112) — 34 new tests
  covering the threshold boundary (29 999 vs 30 000 ms), 0 ms handling, the
  extended format, merging both formats into one song, podcast-row rejection,
  coverage-window computation across both timestamp styles, and the new
  conformance cases for `stream_count` + `meta`.
- **Migration on the real database:** columns added in place, 4044 tracks,
  lyrics `ok=3714 instrumental=144 notfound=186` all preserved.
- **Re-ingest of the real export:** `22013 plays · 17503 listens (30s+) · 4510
  skips`, `223 rows ignored (0 ms)`, `covers 2025-04-16 → 2026-04-17`,
  4044 songs. Play count unchanged from before (the 0 ms rows were already being
  dropped, just accidentally) — so no user-visible number regressed.
- **Live endpoints:** `/stats` `plays 22013 / streams 17503 / hours 1035` with the
  coverage object populated; `/searchForWord?q=door` still **154** results, now
  with `streamCount`; `/song/412` (Habibi) `playCount 60, streamCount 48`.

**Result:** ✅ the numbers are honest and the UI says what they cover. When the
extended export arrives, dropping the files in and re-running `npm run ingest` is
the whole migration.

---

## 2026-07-28 — Phase 1, Step 3: Postgres schema + migrations ✅

**Why:** the SaaS needs a multi-tenant database before an adapter can be written
against it. Building it first — and testing it against a real Postgres — means
Step 4's `PostgresAdapter` is only a translation layer, not a place where schema
design decisions get made by accident.

### What we did

**`apps/web/` workspace created** (`@lyricsearch/web`, private, deps: `pg` +
`dotenv` + `@lyricsearch/core`). Picked up automatically by the root
`workspaces: ["apps/*"]`.

**`migrations/001_init.sql`** — the model from `PROJECT_PLAN.md §7`, now written
out and commented: global `songs` + `lyrics`, per-user `user_songs` / `user_meta`
/ `sessions` / `spotify_accounts` / `uploads`, plus `users` and `login_tokens`.
Documented in full in `docs/06-DATA-MODEL.md`.

Decisions that are load-bearing rather than cosmetic:
- **`lyrics.body_tsv` is a GENERATED column**, not one the app maintains. This is
  the one place Postgres is strictly better than SQLite here: `SqliteAdapter`
  must `DELETE FROM lyrics_fts` and re-`INSERT` by hand, and forgetting once
  means search returns songs whose lyrics no longer exist. A generated column
  cannot drift — and it handles the ok→notfound case for free (body becomes
  NULL, tsvector empties, the song stops matching).
- **`in_library` is `smallint`, not `boolean`** — the contract says 0|1 and the
  routes do `!!row.in_library`; a boolean would arrive as `true`/`false` and fail
  the conformance suite. The column type follows the contract, not the reverse.
- **`ms_played` is `bigint`** — the real user already has 3.7e9 ms in one year,
  and `int4` stops at 2.1e9.
- **Deleting a user is one `DELETE`** — every per-user table cascades from
  `users(id)`, so GDPR erasure cannot rot as tables are added. The global
  catalogue is deliberately untouched; other users still need those songs.
- **`login_tokens.token_hash` is `bytea`** (SHA-256) — a leaked dump must not be
  a set of working login links. **`users.email` is `citext`** — otherwise a
  passwordless link silently creates a second account for the same person.

**`src/migrate.js`** — ~80 lines, no framework. Forward-only plain `.sql` in
filename order; each file in **one transaction** (Postgres has transactional DDL,
so a failure leaves nothing behind); applied migrations recorded in
`schema_migrations` **with a checksum**, and editing an applied migration is
refused rather than silently ignored; a **session advisory lock** around the run
so two app servers booting at once migrate once. No `down` migrations — a
rollback that drops a column is a data-loss button that looks like an undo button.

**`docker-compose.yml`** — Postgres 17 on **port 5433** (not 5432, so it cannot
collide with a locally-installed Postgres), with a healthcheck that means "ready
for queries".

### Verification — 45 new tests, all against a REAL Postgres

Not a mock: the point of this step is to find out how Postgres behaves, not to
confirm what we imagined.

- **Runner (14):** numeric filename ordering (`10_` after `9_`), checksums,
  idempotency, incremental application, **complete rollback of a failed
  migration** (no orphan table, no recorded version), later migrations not
  applied after a failure, refusal on an edited migration, advisory lock released
  on both success and failure.
- **Schema (30):** two users' libraries stay separate; two users share ONE
  `songs` row with independent counts; **stemming works** (searching `door`
  finds a body that only says `doors`) and **`ts_headline` produces the `[[ ]]`
  markers the contract requires**; the generated tsvector updates itself and
  empties when lyrics stop being `ok`; deleting a user erases every per-user
  table and **nothing else**; `citext` email matching; `in_library` returns as a
  **number**; 3.7e9 ms round-trips; `playlists::text` yields the JSON array
  string the contract expects; the GIN index is actually used (verified with
  `EXPLAIN`, not just asserted to exist).

**A real bug in the test setup, found by running everything together:** the first
full run reported `45 tests, pass 15, fail 0` — 30 neither passed nor failed.
`node --test` runs files in parallel processes, and both files dropped and
recreated the *same* test database, so each was tearing down the other's
connections. It looked exactly like schema failures and was not. Fixed by giving
each test file its own database (`..._test_migrate`, `..._test_schema`). Worth
recording because the symptom pointed at entirely the wrong layer.

**Repo total: 289 tests, 0 failures** (core 132, personal 112, web 45).
Verified that with Postgres unreachable the web tests **skip with an explanation**
instead of failing, so the root `npm test` stays green for anyone working only on
the Personal Edition.

### Known issue, recorded for Step 4

`node-postgres` returns `bigint` (`int8`) as a **string**, to avoid silent
precision loss past 2^53. `ms_played` and `spotify_accounts.expires_at` are
`int8`, and the conformance suite requires numbers because the routes do
arithmetic on them. `PostgresAdapter` must cast in SQL (`ms_played::float8`) or
register a type parser. This is exactly the class of difference the conformance
suite was written to catch — now known before the adapter exists.

**Also for Step 4:** `searchByLyrics(ftsQuery)` currently takes a string in
**SQLite FTS5 syntax** (`"door" "open"`), produced by `core.search.toFtsQuery`.
That is a storage-engine detail that leaked into `core`, and Postgres cannot use
it. Step 4 should change the contract to pass the *words* and let each adapter
build its own engine query — `websearch_to_tsquery` for Postgres, the quoted FTS5
string for SQLite.

**Next: Phase 1, Step 4** — `PostgresAdapter` implementing the same
`StorageAdapter` contract, scoped to a `user_id`, and passing the same
conformance suite as `SqliteAdapter`.

---

## 2026-07-28 — Phase 1, Step 4: `PostgresAdapter` ✅

**The payoff step for the whole architecture.** `SqliteAdapter` and
`PostgresAdapter` now pass the **same conformance suite**, so `core` and every
route can hold either one without knowing which. The Liskov commitment in
`01-DECISIONS.md` is now checked by execution rather than asserted in a document.

### 4a — First, a leak in the contract had to be closed

`searchByLyrics(ftsQuery)` took a string in **SQLite FTS5 syntax** (`"door"
"open"`), built by `core.search.toFtsQuery`. That is a storage-engine detail
living in `core`, and Postgres cannot use it — the first thing Step 4 would have
had to do is parse SQLite syntax back into words.

Fixed properly instead:
- `core.search.toFtsQuery` → **`queryWords(q)`**, which returns plain words and
  nothing else. `core` no longer knows any engine's query language.
- **`SqliteAdapter` builds its own** FTS5 expression (`#ftsQuery`, quoting each
  word); **`PostgresAdapter` builds a tsquery** via `plainto_tsquery`.
- Contract, route, conformance suite and tests updated to pass `string[]`.

An unplanned benefit: **invalid search queries are now impossible**. Searching
for `AND`, `(`, `*` or `&` used to be an FTS5 syntax error that the route caught
and turned into a 400; both adapters now quote or escape user input themselves,
so it is simply a search that finds what it finds. Covered by tests on both
sides. (One of those tests failed at first because `["AND"]` legitimately
*matches* — the fixture lyrics contain the word "and". The assertion was wrong,
not the code.)

### 4b — `apps/web/src/postgres-adapter.js`

All 19 contract methods, **scoped to one user**. The constructor throws without a
`userId`: an unscoped adapter would read across tenants, so there is no default.
Tenant isolation lives in this one file and nowhere else, because no route writes
SQL — leaking another user's data would require a bug in here, not a forgotten
`WHERE` somewhere in the API.

Things that needed care, most of them found by the conformance suite:

- **`bigint` as string.** node-postgres returns `int8` as text. Fixed with a
  process-wide `setTypeParser(INT8, Number)` plus `::float8` on aggregates
  (`SUM()` over integers returns `numeric`, also stringified). Pre-registered in
  Step 3 precisely because the suite asserts `typeof === "number"`.
- **Two different "user ids".** The contract's `getAuth().user_id` means the
  **Spotify** user — `core.spotify.createPlaylist(token, row.user_id, ...)` uses
  it as a Spotify identifier. Our accounts also have a `user_id`. The adapter
  aliases `spotify_user_id AS user_id`; returning our bigint would create
  playlists against a Spotify account that does not exist. SQLite's single-row
  `auth` table had no such ambiguity.
- **`playlists` as a JSON string.** The contract says raw JSON array string
  (the host `JSON.parse`s it); node-postgres parses `jsonb` into an object, so
  the adapter selects `playlists::text`.
- **`close()` is a no-op.** The pool is shared by the process and by every
  tenant's adapter; ending it because one request finished would kill the next.
  The conformance suite's `destroyAdapter` hook exists for exactly this.
- **Atomicity across two tables.** `upsertSongs` writes global `songs` and
  per-user `user_songs`; both run in one transaction, so a failed batch leaves no
  orphan rows in the shared catalogue either. Set-based via `unnest()` — one
  round trip per table rather than one per song, for ~4000-song ingests.
- **No index maintenance.** `saveLyrics` just writes; `lyrics.body_tsv` is a
  GENERATED column. The SQLite adapter has to DELETE and re-INSERT its FTS row by
  hand.

### Verification — 70 tests in the adapter file alone

- **The full conformance suite passes on Postgres**, unchanged from the run
  against SQLite. Same file, same assertions, two completely different engines.
- **45 Postgres-specific tests** for behavior SQLite cannot have: one tenant
  never sees another's songs, stats, search results or lyric counts; guessing
  another tenant's song id returns `null`; a shared song is stored **once**
  with independent per-user counts; **lyrics fetched by one user serve every
  other user who owns that song** (and the second user is never asked to
  re-fetch); a resolved Spotify URI is shared globally but cannot be written by
  someone who does not own the song; account deletion erases the tenant and
  leaves both the catalogue and the other tenant intact; 3.7e9 ms round-trips;
  tsquery operators are neutralised.

**A finding worth recording:** `testing/fixtures.js` `seed()` can only be used
**once per database** in the hosted model. It learns song ids from
`getSongsNeedingLyrics()`, which correctly returns nothing for a second tenant
once the lyrics exist — because lyrics are global. The first version of the
account-deletion test called `seed()` twice and failed with `bigint: "NaN"`.
That is the shared-catalogue design working exactly as intended; the fixture doc
now says so, and a second tenant should call `upsertSongs(SONGS)` and inherit the
lyrics.

**Repo total: 362 tests, 0 failures** (core 133, personal 114, web 115).

**Next: Phase 1, Step 5** — `apps/web` HTTP API: passwordless accounts,
sessions, upload intake behind a `BlobStore`, and the read routes on top of
`PostgresAdapter`. The routes should be close to a copy of `apps/personal/src/
app.js`, because that is what the shared contract was for.

---

## 2026-07-28 — Phase 1, Step 5: web API, accounts, upload intake ✅

**Why:** with the adapter proven, the service needed the parts that make it a
service — a way in (accounts), a way to give it data (uploads), and the read
routes on top.

### What we did

**`src/blob-store.js`** — `BlobStore` interface + `LocalBlobStore`. The same move
as `StorageAdapter`, one layer over: local disk now, S3/R2 later is a new class,
not a rewrite. Keys are generated **here** (`2026-07/<32 hex>`) and never derived
from user input — the moment an uploaded filename can influence a path,
`../../etc/passwd` is a valid upload. `#pathFor` refuses any key that resolves
outside the root.

**`src/mailer.js`** — `Mailer` + `ConsoleMailer` (prints the link, the dev
default) + `MemoryMailer` (tests assert on what would have been sent).

**`src/auth.js`** — passwordless sign-in. Two rules run through it:
- **Raw tokens never touch the database.** Only SHA-256 digests are stored, for
  both login links and sessions, so a leaked dump is not a set of working logins.
- **Sign-up and sign-in are the same flow.** The account is created the first
  time a link is used, which is why `login_tokens` is keyed by email not user id.

Single-use is enforced by `UPDATE ... SET consumed_at = now() WHERE consumed_at
IS NULL ... RETURNING`, so two simultaneous clicks cannot both win. Links live 15
minutes, sessions 30 days, and requests are capped at 5/hour/address — the cap is
about inbox abuse, not credential stuffing, since a link is useless once used.

**`src/app.js`** — `createApp({ pool, blobStore, mailer, baseUrl })`, same factory
pattern as the Personal Edition. A middleware resolves the session cookie and
attaches **a PostgresAdapter scoped to that user**; every private route uses
`req.store`. No route contains SQL, so no route can forget to filter by tenant.

Choices worth recording:
- **`POST /uploads` takes the raw body**, not multipart. A browser can
  `fetch(url, {body: file})` and an API client can pipe a file, with no parser
  and no dependency. Capped at 200 MB.
- **It answers `202`, not `200`** — parsing happens in the worker (Step 6).
  Holding a request open for a multi-minute ingest is what the queue is for.
- **The blob is written before the row.** A row pointing at a missing blob is
  worse than a blob nothing points at, which is merely garbage to collect.
- **`GET /song/:id` never returns the lyric body.** `hasLyrics: true` instead.
  The hosted service shows match + snippet only — the single largest copyright
  exposure this product has (`PROJECT_PLAN.md` §3/§5). There is a test asserting
  the body is absent from the response text.
- **`/auth/request-link` answers identically** for known, unknown and
  rate-limited addresses, or it becomes a way to ask "does this person have an
  account here?".
- **The top-words cache is keyed by user and bounded.** The Personal Edition's
  was a module-level global; in a multi-tenant process that is a cross-tenant
  leak. There is a test for it.
- **`DELETE /me` is one statement.** Everything cascades from `users(id)`.

**`src/server.js`** — migrates on boot (safe: the runner takes an advisory lock,
so ten app servers starting at once migrate exactly once), then listens. It
**refuses to start in production** while the mailer is `ConsoleMailer`.

### Verification — 55 new tests, plus a real end-to-end run

`npm test` **417 passing, 0 failures** (core 133, personal 114, web 170).

- **`blob-store.test.js` (11):** binary round-trip, 5 MB blob, identical content
  gets different keys, keys are unguessable, **path traversal refused**
  (`../secret`, `/etc/passwd`, `a/../../b`), delete is idempotent.
- **`api.test.js` (44):** the full sign-in flow; account created on first link
  use and not duplicated on the second; case-insensitive email; **identical
  responses for known vs unknown addresses**; raw token absent from the database
  and equal to `hashToken()` of what was mailed; link single-use; expired link
  refused; rate limit at 5/hour and scoped per address; cookie is `HttpOnly` +
  `SameSite=Lax`; session token stored hashed; **logout invalidates the token
  server-side, not just the cookie**; every private route 401s when signed out;
  uploads stored byte-identical with a filename that cannot influence the path;
  and, throughout, **a second signed-in user sees none of the first's songs,
  stats, uploads, top-words or song ids** (their id 404s, indistinguishable from
  not existing).

**Then run for real**, because passing tests is not the same as booting:
`npm start` migrated a fresh database, printed a sign-in link, and the link →
session → `/me` → upload → `/uploads` → blob-on-disk → `/stats` → link-reuse-
refused → logout sequence all behaved. The uploaded bytes were verified on disk.

### Known gaps going into Step 6

- **Uploads are stored, not processed.** `status` stays `pending` until the
  worker exists.
- **Unzipping needs a dependency.** Node has `zlib` (gzip/deflate) but no zip
  *container* reader, so Step 6 has to add one (yauzl or similar) or accept
  loose `.json` files.
- **No real mailer.** Deliberate, and the server enforces it.

**Next: Phase 1, Step 6** — the pg-boss worker: parse an upload into
`core.ingest.buildSongs` → `upsertSongs`, and a **global** lyric fetcher that
fills `lyrics` once per song for the whole user base.

---

## 2026-07-28 — Phase 1, Step 6: the worker ✅ (the service now works end to end)

**Why:** uploads were being stored and never read. This is the step that turns
the stored blob into a searchable library.

### A dependency decision: reading zips

Node has `zlib` (gzip/deflate) but no ZIP *container* reader, so this needed
either a dependency or ~200 lines. We wrote it — `packages/core/src/zip.js` —
and the reason is the threat model, not the dependency budget: this parses a file
an anonymous user uploaded. Extraction libraries write to disk, which is where
the entire **zip-slip** class of bugs lives (an entry named
`../../etc/cron.d/x`). A reader that returns Buffers and never writes anything
cannot have that bug.

What it defends against, all tested: **zip bombs** (every inflate capped via
zlib's `maxOutputLength`, plus a per-entry and total cap), **lying headers**
(declared size checked against what actually inflated), **tampering** (CRC32
verified), and pointless work (`filter` runs on the entry NAME, before any
decompression). It **refuses** rather than guesses on zip64, encrypted entries
and unknown compression methods — a Spotify export is none of those, and
silently misreading a container is worse than failing.

`readSpotifyExport()` matches on the **basename**, so the enclosing folder does
not matter (Spotify nests the export; users re-zip things themselves), and skips
`__MACOSX/._*` resource forks, which have the right basename and are not JSON.

Tests build archives with a small ZIP **writer** (`core/testing/make-zip.js`)
rather than a checked-in binary fixture — a fixture is opaque and cannot be
varied, and this lets a test say "an entry with a lying size header" in one line.

### The worker

**`src/queue.js`** — a `Queue` interface with `PgBossQueue` and `NullQueue`. The
API only ever *enqueues* and never imports pg-boss; the tests use `NullQueue` to
assert that a route handed work off without running a queue.

**`src/lyric-catalog.js`** — the global lyric store, **deliberately not a
StorageAdapter**. That contract is per-tenant, and fetching lyrics is the one
operation with no tenant. Forcing it through a user-scoped adapter would need a
fake user or a "global mode" flag, either of which would make it possible to call
a genuinely per-user method without a user. Pending songs are ordered by **how
many users own them**, so with a backlog the fetch that unblocks the most people
happens first.

**`src/jobs/parse-upload.js`** — blob → `readSpotifyExport` →
`core.ingest.buildSongs` → `upsertSongs` + `setMeta`. It **claims** its row
(`UPDATE ... WHERE status = 'pending'`), because at-least-once is the only
delivery guarantee a queue gives and a redelivered job must be a no-op rather
than a double ingest. A bad upload is recorded on the row and **not rethrown**:
that is the user's problem to see on the uploads page, not an incident, and
retrying a corrupt zip corrupts it again.

**`src/jobs/fetch-lyrics.js`** — global fetch, concurrency 4, 250 ms between
requests. A song LRCLIB cannot answer for is recorded as `error` and the run
continues.

**`src/worker.js`** — a separate process from the API (`docs/02-SCALABILITY.md`):
parsing a 20k-row export is minutes of work, and doing it in the web process
would make request latency depend on who happened to upload something. Uploads
trigger a lyric sweep, collapsed by `singletonKey` so a hundred simultaneous
uploads cause one sweep, not a hundred. A cron schedule (`*/15`) catches
stragglers. Batches re-queue themselves rather than draining the backlog in one
run, so a restart loses little and one huge upload cannot monopolise the worker.

### Verification — 478 tests, and a real end-to-end run

`npm test`: **478 passing, 0 failures** (core 163, personal 114, web 201).

- **`zip.test.js` (30):** stored and deflated archives, binary round-trip,
  multi-block content, nested paths, archive comments, UTF-8 names; and the
  refusals — bomb, size-cap, lying header, bad CRC, encrypted entry, unknown
  method, zip64, truncation, central directory past EOF.
- **`jobs.test.js` (29):** an export becomes a library with the right merge;
  coverage window and skip threshold recorded; extended-history detected;
  **re-running a job does not double-count**; a second upload adds without
  duplicating; two users' identical exports produce two libraries and **one**
  global song; every failure path lands a readable reason on the row and leaves
  the library untouched; the catalogue orders by owner count; **one fetch serves
  every user who owns the song** (asserted: exactly one HTTP call, both users can
  then search it); misses are recorded so a song is never looked up twice.

**Then run for real, both processes, against LRCLIB itself.** Uploaded an export
containing three real songs:

```
parse-upload #1: done (3 songs)
fetching lyrics for 3 song(s)
lyrics: ok=3 notfound=0 instrumental=0 error=0
catalogue: 3/3 songs processed, 0 pending
```

`/searchForWord?q=tear` then returned *Love Will Tear Us Apart* with 8
occurrences and a `[[tear]]`-marked snippet — real lyrics, fetched from the real
service, indexed by Postgres, searched through the shared `core`. A deliberately
corrupt upload came back `failed | not a zip file (no end-of-central-directory
record)` and left the library untouched.

**Next: Phase 1, Step 7** — the Next.js frontend, the last step of Phase 1.

---

## 2026-07-28 — Phase 1, Step 7: Next.js frontend ⚠️ INCOMPLETE — READ THIS FIRST

**Status: written and building, but the signed-in journey was NOT verified.**
The session was stopped partway through end-to-end testing. Do not assume this
step is done.

### What exists

New workspace **`apps/web-ui`** (Next.js 15, App Router, React 19). Note the
deviation from `PROJECT_PLAN.md §9`, which put the frontend at
`apps/web/frontend`: a nested workspace inside a workspace package causes npm
tooling pain, so it is a sibling workspace instead.

- `next.config.mjs` — rewrites `/api/*` **and** `/auth/*` to the API process, so
  the browser sees ONE origin: no CORS, and the session cookie is same-origin
  rather than a third-party cookie browsers increasingly refuse.
- `lib/api.js` — server components call the API directly and forward the
  caller's cookie by hand.
- Pages: `/` (landing, the SEO surface), `/signin`, `/app` (search),
  `/app/stats`, `/app/upload`. Only two client components
  (`signin/form.js`, `app/upload/form.js`); everything else is server-rendered.
- `app/globals.css` — plain serif, no framework, keeping the Personal Edition's
  deliberately unfashionable look.

**API change:** `/auth/callback` now redirects a *browser* to `/app` instead of
returning JSON, detected on a literal `text/html` in `Accept` (browsers send it,
`fetch` sends `*/*`), so API clients keep the JSON. A bad link redirects to
`/signin?error=…`. **This change has no test yet — add one.**

### Verified

- `next build` succeeds; all six routes compile.
- All three processes run together; `/api/health` proxies correctly.
- The landing page is **real server-rendered HTML** — `<title>`, headline and the
  12-month warning are all in the source, not injected by JS.
- Signed-out `/app` → 307 to `/signin`.
- The emailed link works **verbatim** in a browser: 302 → `/app`, cookie set.

### An integration bug this caught

The first `next.config.mjs` only proxied `/api/*`, but the emailed link is
`/auth/callback` — which would have 404'd in a browser while every automated test
passed, because the tests call the API directly. Fixed by proxying `/auth/*`
under its own name. **This is the class of bug the remaining verification is for.**

### NOT verified — do this first in the next session

1. **Upload → parse → search through the UI.** Sign in, upload an export at
   `/app/upload`, confirm the worker processes it, then check `/app?q=tear` and
   `/app/stats` render real data. (This is where the session stopped.)
2. **`/app/stats` coverage warning** rendering with real ingest metadata.
3. **The upload client form** in an actual browser (it has never been run).
4. **A test for the `/auth/callback` browser redirect** in `apps/web/test/api.test.js`.

### Also outstanding for Phase 1

- No automated tests cover the frontend at all. Options: Playwright, or curl the
  SSR HTML from a test. The latter fits this repo's dependency ethos.
- `docs/04-TESTING.md` has not been updated for `apps/web` or `apps/web-ui`.
- Test counts in `apps/web/README.md` and `docs/06-DATA-MODEL.md` are stale.

---

## 2026-07-28 (later) — Step 7 verification: the signed-in journey, for real ✅

Picks up the "NOT verified" list from the entry above. **Items 1, 2 and 4 are
now done; item 3 is not, and cannot be from here.**

### How it was verified

Against a **completely empty catalogue** (`catalogue: {"songs":0,…}` at worker
boot), so nothing below is a leftover from an earlier run.

All three processes up, with `BASE_URL=http://127.0.0.1:3000` — the emailed link
has to point at the *frontend*, not the API, or the browser never reaches the
`/auth/*` rewrite. **The API's default `BASE_URL` is `:3001`, which is wrong for
any run that involves a browser.** Worth remembering.

Every request went **through the :3000 proxy**, replicating exactly what the two
client components send (`signin/form.js`, `app/upload/form.js`) — same method,
same headers, same body — so the proxy hop is part of what was tested rather
than bypassed.

The fixture was **real data, deliberately bounded**: the 40 most-played tracks
from the actual `apps/personal/Data` history, all of their plays (3,511), zipped
with `core/testing/make-zip`. Real enough for real lyrics, small enough that the
LRCLIB sweep is seconds rather than an hour.

### What happened

1. Sign-in POST → `{"ok":true}`; link printed pointing at `:3000`.
2. Clicking it with a browser `Accept` → **302 → `/app`**, `ls_session` set
   `HttpOnly; SameSite=Lax`. `/me` confirms the account.
3. Signed-out `/app` → **307 → `/signin`**.
4. Upload → `202 {"status":"pending"}` → worker:
   `parse-upload #2: done (40 songs)` → `lyrics: ok=36 notfound=2
   instrumental=2 error=0` → `catalogue: 40/40 processed, 0 pending`.
5. **`/app?q=rain`** — server-rendered, real: *Rhinestone Eyes* — Gorillaz, with
   `<mark>rain</mark>` inside "While rain is falling like rhinestones from",
   `played 115× (89 listens)`, header `40 songs · lyrics found for 36`.
6. **`/app/stats`** — `3496 plays · 3017 listens · 195 hours · 40 songs ·
   32 artists`, both tables, and the top-words list linking back into `/app?q=`.
   Counts agree with the search page (115/89 for Rhinestone Eyes both places).
7. **The coverage warning renders with real ingest metadata** (item 2): window
   `2025-04-16` → `2026-04-17`, correctly identified as the 12-month "Account
   data" export, with the prompt to request extended history.
8. `/app/upload` afterwards lists `verify-export.zip | done | 40`.
9. **Tenant isolation holds through SSR** — a second signed-in user's `/app?q=rain`
   says "Nothing to search yet / 0 songs" and their `/app/stats` is the empty
   state. This is the path where `lib/api.js` forwards the cookie *by hand*, so
   it is worth checking separately from the API's own isolation tests.

### `/auth/callback` now has tests (item 4)

Six, in `apps/web/test/api.test.js` under **"GET /auth/callback from a browser"**
— the branch every other test in the file skips, because they all speak as API
clients. Browser: redirects to `/app`; **sets the session cookie on the way
past** (a redirect that forgets it looks correct and bounces the user straight
back to `/signin`); dead and reused links redirect to `/signin?error=…` rather
than showing JSON. API client: still `200 {ok,isNewUser}` and still `400` — the
guard that adding the redirect did not break non-browser callers.

`node --test test/api.test.js`: **51 passing, 0 failures.**

### Still open

- **Item 3 — the upload form in an actual browser — is still not done.** The
  *request* it sends has now been exercised verbatim; what is unverified is the
  React state handling around it (disabled button, `router.refresh()`, the error
  branch). That needs a real browser, and adding Playwright is a dependency
  decision this repo has so far declined.
- **Frontend has no automated tests yet.** Started, not finished: the plan is to
  boot API + Next on random ports from a test and assert on the fetched SSR HTML
  — no browser engine, which fits the repo's dependency ethos. The manual run
  above is exactly the script such a test should automate.
- `docs/04-TESTING.md` still does not cover `apps/web` / `apps/web-ui`; test
  counts in `apps/web/README.md` and `docs/06-DATA-MODEL.md` are still stale.
- `docs/05-PHASE-1-SAAS.md` still marks step 7 `[~]`. The verification is done;
  the frontend test layer is what is left before it is `[x]`.

## 2026-07-29 — Step 7 finished: the frontend has tests ✅ (Phase 1 complete)

Closes the "still open" list from the entry above, except the one item that
cannot be closed without a browser.

### `apps/web-ui/test/pages.test.js` — 31 tests

A real Next dev server on a random port, a real API on another, a real Postgres,
and assertions on the HTML that comes back. **515 tests repo-wide** (core 163,
personal 114, web 207, web-ui 31), 0 failures. The frontend layer runs cold in
about 8 seconds.

The technique and the reasoning are written up properly in `04-TESTING.md`
§Layer 5. The one discovery worth repeating here:

**`next dev` reads `next.config.mjs` at boot, so the rewrites pick up
`API_ORIGIN` from the environment.** That is the whole reason this is cheap — a
test can start the API on a random port and point a dev server at it. With
`next build && next start` the rewrite destination is baked into the routes
manifest and every run would need a rebuild. Chosen after spiking both.

Two small changes fell out of it: `next.config.mjs` now takes `distDir` from
`NEXT_DIST_DIR` (so `node --test` and an open `npm run dev` cannot corrupt each
other's `.next`), and `@lyricsearch/web-ui` has a `test` script, so the root
`npm test` actually runs it. A test suite nothing runs is a test suite that rots.

### What the 31 cover

The manual sequence from the previous entry, automated, plus the things a manual
pass does not bother to check twice:

- **The landing page is real HTML in the response body** — title, meta
  description, headline, the 12-month warning — asserted from the crawler's
  position, before any hydration. That is the entire justification for SSR.
- **Both rewrites**, `/api/*` and `/auth/*`, the second under its own name.
- **The full sign-in journey**: form POST → the emailed link's *path used
  verbatim* → 302 → `/app`, cookie set, and the session surviving the hop.
- **The dead-link path all the way to the page the user reads**, not just the
  redirect: `/signin` rendering "invalid, expired, or already used".
- **Sign-out through the proxy**, then `/app` bouncing to `/signin`.
- **Search**: `<mark>door</mark>`; the stemmed hit rendered as `doors`, the word
  the lyric actually uses, rather than the query echoed back; non-matching songs
  absent; `played 30× (24 listens)` — plays and listens never collapsed into one
  number; `6 songs · lyrics found for 3 · 1 still being looked up`.
- **Escaping.** A song titled `Corridor <script>alert("track")</script>` with a
  script tag in its lyric body renders escaped, not executed. Titles come from a
  file a stranger uploaded and bodies from a third-party API; the snippet is the
  one place in the app where the obvious implementation is
  `dangerouslySetInnerHTML`.
- **Stats**: `57 plays · 44 listens · 2 hours · 6 songs · 4 artists`, both
  tables, and Open Door's 30/24/90 matching what the search page prints — the two
  pages cannot silently disagree.
- **The coverage warning both ways**: present and `notice warn` for an
  account-data export, gone for an extended one.
- **Upload through the proxy**: the raw zip as the body and the name in the query
  string, exactly what `app/upload/form.js` sends. Binary through a rewrite is
  precisely the thing that works in curl and not in the proxy.
- **Tenancy through SSR**: a second signed-in user gets the empty states. This is
  the path where `lib/api.js` forwards the cookie *by hand*, so it is worth
  checking separately from the API's own isolation tests.
- **No cross-request leakage**: an anonymous `/app?q=door` right after the owner
  rendered the same URL still 307s and contains none of their songs.

### The suite was checked against the bug it exists for

Deleting the `/auth/:path*` rewrite — the exact mistake from 2026-07-28 — turns
the suite red immediately. It fails hard in the `before` hook, because sign-in
stops working and there is no user to hang a library off, so every test goes with
it. Noisy, but unmissable, which is the right trade for this particular bug.

### Docs

- `04-TESTING.md` now covers `apps/web` (Layer 4) and `apps/web-ui` (Layer 5) —
  per-file databases, the synchronous Postgres probe, `NullQueue`, the
  `<!-- -->` stripping, why the emailed link's path is reused verbatim, and the
  `BASE_URL` trap.
- Stale counts fixed in `apps/web/README.md` and `06-DATA-MODEL.md` (201 → 207).
- `05-PHASE-1-SAAS.md` step 7 → `[x]`. **Phase 1 is complete.**

### The gap, still open and still deliberate

**The upload form has never executed in a real browser.** Its request is now
exercised byte for byte, but the React state around it — disabled button,
`router.refresh()`, the error branch — does not run. That needs Playwright, and
the dependency has not been agreed. It is written down in three places now
(`04-TESTING.md`, `apps/web-ui/README.md`, the top of `pages.test.js`) so nobody
reads a green run as more than it is.

### Also this session

`docs/07-FUTURE-FEATURES.md`, new: the weekly/monthly **lyrical summary**.
Decided: rolling 7/30-day windows, live Spotify `recently-played` as the source,
minutes played as the weight.

**The mechanism was revised once during the session, and the revision is the
interesting part.** The first draft made *embeddings* the only thing that read
the lyric body — one vector per song, minutes-weighted centroid, nearest theme
label. That is lossy in exactly the wrong place: it is good at "how close are two
songs" and bad at "name the topics and say which songs carried them", which is
the feature. Replaced with a **per-song analysis stage that reads the full lyric
body** and emits themes with confidences; the window is then a minutes-weighted
mean over *those*, with embeddings kept as a supporting signal. Same global
"analyse once per song, share with every user" economics as the lyric catalogue.
The tally also sidesteps the centroid's worst failure — a mixed week comes out
bimodal rather than averaging into a point that means nothing.

Two corrections recorded in the doc rather than quietly fixed:

- The first draft argued for keeping lyric bodies on the server for **privacy**.
  Wrong, and withdrawn there. Lyric bodies are not user data — they are identical
  for every user, which is why they are stored globally. The user-private facts
  are which songs someone played and when. The real question is **licensing**
  (`PROJECT_PLAN.md §5`), and §5's concern is public *display*, which is not the
  same as processing. Stated properly in the doc.
- Consequently the hosting recommendation flipped. Analysing lyrics is now the
  **strongest self-hosting candidate in the project** — high volume, batchable,
  latency-insensitive, narrow task, and the one step where sending data out is
  legally awkward. Prose-writing starts hosted: low volume, no lyric bodies, and
  eloquence is what small local models are worst at.

Also worth knowing before anyone starts: it has a **hard Phase 2 dependency**. An
export has no concept of "this week", genres come from the API, and
`recently-played` returns only the last 50 plays — so it needs polling *and* a
new per-user play-events table.

## 2026-07-29 (later) — the deploy layer ✅ (Phase 1 can ship)

Phase 1 was finished and unshippable: no Dockerfile for either hosted app, no
compose file, no reverse proxy, no backups, and a `server.js` that refused
`NODE_ENV=production` outright because the only mailer printed to a terminal.
All of that now exists in `deploy/`, and the whole stack has been run end to end.

Full walkthrough in the new **`docs/08-DEPLOYMENT.md`**. What follows is what was
decided and what the process taught, not a repeat of it.

### A real mailer

`SmtpMailer` (nodemailer — one new dependency, chosen deliberately). SMTP rather
than one provider's HTTP API because it is the one interface all of them speak:
Resend, Postmark, SES, Mailgun and a box in a cupboard are a host, a port and a
credential. Changing provider is an edit to `.env`, which matters for the one
message the service cannot function without.

Both configuration shapes are supported, and the second is not redundant:
`SMTP_URL` for the common case, and discrete `SMTP_HOST`/`SMTP_USER`/
`SMTP_PASSWORD` because **SES SMTP passwords are base64 and routinely contain
`+` and `/`**, which do not survive being parsed as part of a URL.

The interesting part is `mailerFromEnv()`, which lives in `mailer.js` rather than
`server.js` **so that the rule is testable**, because it is a security rule and
not a configuration detail: production with no SMTP configured does not fall
back to `ConsoleMailer`, it refuses to start. Sign-in links in a container log
are readable by everyone with log access and by nobody trying to log in. A
service that is down is an incident; a service that mails sign-in links to a log
file is a breach.

Three more boot-time refusals in `server.js`, all the same idea — a
misconfiguration that is otherwise invisible until a user hits it:

- **`BASE_URL` unset in production.** It defaults to the API's own
  `127.0.0.1:3001`, so every emailed link would be dead.
- **`BASE_URL` not `https://`.** Session cookies are `secure`; a browser on a
  plaintext origin takes the redirect and silently drops the cookie. Sign-in
  appears to work and does nothing.
- **`transport.verify()`** at boot. A wrong SMTP password otherwise surfaces as
  the *first user's* failed login rather than as your failed deploy.

`apps/web/test/mailer.test.js` — 20 tests, no network. `SmtpMailer` is exercised
through nodemailer's `jsonTransport`, which builds the real MIME message and
returns it instead of opening a socket, so the assertions are against what would
go on the wire rather than against a fake that agrees by construction.

### The images

**One image for the API and the worker.** Same dependencies, same `src/`, only
the entry point differs; compose overrides the command. `npm ci --omit=dev
--workspace @lyricsearch/web --include-workspace-root` installs one workspace's
tree, so the API does not carry Next and React. Every workspace's
`package.json` still has to be copied in first — `npm ci` validates the whole
lockfile against the workspaces it declares and refuses a tree with one missing.

**The frontend is a two-stage build on `output: "standalone"`**, so the runtime
stage is a traced server and no npm tree at all. `outputFileTracingRoot` is set
explicitly rather than left to infer from the nearest lockfile: in a monorepo a
wrong guess means either a missing module at runtime or the entire repo in the
image. Two details that are easy to get wrong and silent when you do —
`.next/static` is *not* part of standalone output and must be copied separately,
and `HOSTNAME=0.0.0.0`, because the standalone server binds loopback by default
and a container answering only itself is invisible to Caddy.

Both run as the `node` user. `/data` is created and chowned before the drop, so
the named volume inherits the right ownership on first mount.

### Caddy, and the second copy of the routing table

Caddy terminates TLS and routes `/api/*` (stripping) and `/auth/*` (not
stripping) to the API, everything else to Next. That is deliberately **not** what
the test suite exercises — the tests go through `next.config.mjs`'s rewrites —
and the reason to diverge is the upload path: an export body can be 200 MB and
there is no reason to push it through a Node proxy that only forwards it.

But it means one routing table lives in two files, which is the exact shape of
the bug this project already had (2026-07-28: `/api/*` proxied, `/auth/*` not,
478 tests green, nobody able to sign in). So
**`apps/web-ui/test/deploy-routes.test.js`** imports `next.config.mjs`, reads
`deploy/Caddyfile`, and asserts they describe the same routes: that `/api` is
stripped on both sides and `/auth` on neither, that a catch-all exists, that
every `reverse_proxy` upstream is a service name that exists in
`docker-compose.yml`, and that Caddy's body cap is *above* the API's 200 MiB so
the app's JSON 413 is what a user sees rather than an opaque proxy rejection.
Checked against the bug it exists for: changing `handle /auth/*` to
`handle_path /auth/*` turns exactly that one test red.

### It was actually run

Not "the config looks right" — the whole stack, built and exercised.
`deploy/local-trial.yml` runs it over plain HTTP with no DNS and no mail
provider, changing exactly three things, all consequences of having no TLS
(`NODE_ENV=development`, an `http://` `BASE_URL`, and `:80` so Caddy does not
try to certify a name that does not resolve). Images, routing, volumes,
healthchecks and boot order are production's.

Every hop verified through Caddy on :80: sign-in link requested → the emailed
path used verbatim → 302 to `/app` with the session cookie surviving the proxy →
`/app` server-rendered as the signed-in user → a raw zip uploaded → **the worker,
in its own container, parsed it** → `/api/stats` and the stats page showing the
song → sign-out → anonymous `/app` bouncing to `/signin`. The worker also
reached LRCLIB from inside the container and filled the catalogue (`ok=1`).

Two things only a real run found, both now fixed and both documented where the
error message will be read:

- **Two compose services sharing one `image:` tag both try to build it**, and
  buildx fails with "image already exists". Only `api` carries the `build:`
  block now; `worker` just names the image.
- **An empty `ACME_EMAIL` is a Caddy parse error**, not a warning — the container
  restart-loops on "wrong argument count or unexpected line ending after
  'email'". `caddy validate` had passed because it was run *with* a value. That
  message is now in the Caddyfile, in `.env.example` and in the deployment doc's
  troubleshooting list.

### Backups

`deploy/backup.sh` — `pg_dump` through the running container, so the host needs
no Postgres client and no published database port. Writes `.part` and renames on
success, because an interrupted dump that looks like a good backup is worse than
no backup; fails loudly if the result is implausibly small, because gzip happily
succeeds on pg_dump's error output. Postgres only: the uploaded zips restore
nothing (they are already parsed into the database) and certificates re-issue in
seconds. The doc says plainly that leaving dumps on the same disk protects
against `DROP TABLE` and not against losing the box, and that a backup you have
never restored is a hypothesis.

### Counts

**541 tests** (core 163, personal 114, web 227, web-ui 37), 0 failures. +20
mailer, +6 deploy routing. Stale counts updated in `04-TESTING.md`,
`05-PHASE-1-SAAS.md`, `06-DATA-MODEL.md`, and both hosted READMEs.

### What is left before it is actually deployed

None of it is code:

1. A VPS with Docker.
2. A domain, with DNS pointed at the box **before** the first `up` — Caddy
   proves control over port 80 to get a certificate.
3. An account with a transactional-email provider, with SPF and DKIM set up on
   the sending domain. Sign-in mail that lands in spam is sign-in that does not
   work.

Then `cp .env.example .env`, fill it in, `docker compose up -d --build`, and sign
in as yourself before telling anyone the address — it is the one path that
crosses Caddy, Next, the API, Postgres and the mail provider, and the only way to
learn that the email really arrives.

Deliberately not built, each a rung on `02-SCALABILITY.md`'s ladder: Cloudflare
in front (worth doing on day one anyway, and free), object storage for uploads,
Redis, PgBouncer, more than one app container, a staging environment, log
shipping. Today's operational surface is `docker compose logs` and an uptime
monitor on `/api/health`, which 503s rather than 200s when Postgres is
unreachable.
