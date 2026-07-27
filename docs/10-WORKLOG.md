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
