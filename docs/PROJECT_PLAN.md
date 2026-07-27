# Project Plan & Handoff Brief

> **Purpose of this document.** It compacts the full context of the project so a
> fresh planning session can continue without re-deriving anything. It records
> what exists today, the decisions already made, the two-track product vision,
> the proposed architecture for the hosted service, scalability thinking, a
> concrete folder structure, and the open questions to resolve next.
>
> _Not legal advice — the compliance notes are a practical read, to be confirmed
> with a lawyer before the commercial service launches._

---

## 1. What this project is

Search your **own Spotify listening data by the words in song lyrics**
("which of my songs mention _door_?"), see every match across library +
playlists + streaming history with the lyric line highlighted, and turn a search
into a real Spotify playlist.

## 2. Two-track product vision

| | **Personal Edition (OSS)** | **Hosted Service (SaaS)** |
|---|---|---|
| Audience | Self-hosters, developers | General public |
| Distribution | Public GitHub repo | Website on a domain |
| Spotify creds | User brings their own app | One shared registered SDA |
| Data | Local, single-user | Multi-tenant, per-user isolation |
| Storage | SQLite (`node:sqlite`) | Postgres |
| Monetization | None (free/open) | **Advertising** |
| Role | Escape hatch / trust anchor | The product |

The Personal Edition is deliberately the **fallback**: if Spotify ever revokes
API access, users can still self-host and run on their own uploaded export. The
two editions **share one core** so they never diverge (see §6).

## 3. Decisions already made (do not relitigate)

- **Register as a Spotify SDA and use the Web API.** Many more features planned;
  the API is worth the Developer-Terms obligations. Will apply for **Extended
  Access** when growing past Dev Mode's 25-user cap.
- **Scale posture: start small, grow later.** Launch invite-only (Dev Mode),
  build multi-tenant from day one, apply for Extended Access once proven.
- **Data intake: hybrid.** Spotify Web API for instant onboarding (saved tracks,
  playlists, top tracks, recently-played) **plus** optional GDPR export upload
  for users who want full streaming history (the API cannot provide full
  history).
- **Lyrics: match + short snippet only** in the public service — never full
  lyric text. This is the main copyright-exposure lever. Lyrics source is
  **LRCLIB** (free, no key).
- **Keep playlist creation.** It requires the API/OAuth; it is the reason the
  service is a Spotify SDA at all.
- **Keep the Personal Edition fully functional** as an offline, upload-only,
  no-Spotify-API path.

## 4. Current state (what already exists — the starting point)

A working **single-user** app lives in this repo:

- **Backend** — Express 5, CommonJS, Node 24 (uses built-in `node:sqlite`).
  - `src/db.js` — SQLite schema + FTS5 (porter stemmer). Matching helpers:
    `matchKey`, `normalize`, `cleanTitle` (strips "- 2020 Remaster" etc. so the
    same song from different exports collapses to one row).
  - `src/ingest.js` — reads export JSON (`YourLibrary`, `Playlist1`,
    `StreamingHistory_music_*`) into `tracks`, one row per song, merging library
    + playlists + play counts.
  - `src/lyrics.js` — fetches lyrics from LRCLIB with concurrency + exponential
    backoff on 429/5xx, indexes into FTS. (~92% coverage: 3,714 of 4,044 tracks.)
  - `src/spotify.js` — OAuth (auth-code flow), token refresh, `resolveUri`
    (only ~22% of exported rows carry a Spotify URI, so missing ones are looked
    up via the Search API and cached), `createPlaylist`, `addTracks`.
  - `src/server.js` — routes: `/searchForWord`, `/song/:id`, `/topWords`,
    `/stats`, `/status`, `/login`, `/callback`, `/logout`, `/me`,
    `/createPlaylist`.
- **Frontend/index.html** — plain static UI (serif, intentionally not
  "AI-looking"): search, checkbox playlist-builder flow, top-words, stats.
- **Data/** — personal export + generated `spotify.db`; git-ignored, empty in
  the repo. `Data/README.md` explains how users get their export.
- **Ops** — `Dockerfile`, `docker-compose.yml`, `docker-entrypoint.sh`,
  `.dockerignore`, root `.gitignore` (excludes all personal data, `.env`,
  `.claude/`, `*.db`), `.gitattributes` (LF for shell scripts), `README.md`.
- **Git** — initialized, **not yet committed**. `git check-ignore` verified no
  personal data would be tracked (only ~19 code/doc files).

This code becomes the **Personal Edition** and the seed of the shared core.

## 5. Legal / compliance map (practical, confirm with counsel)

- **Spotify Developer Terms bind you only when you use the Platform.** The core
  search/snippet features run on user-uploaded data with **zero** Spotify
  footprint. Only two features pull you under the Terms: instant API data-pull
  and playlist creation.
- **Extended Access is a gate.** Public signup requires Spotify's review; it can
  be refused. Validate this early.
- **Lyrics copyright is the larger, Spotify-independent risk.** Public display of
  lyrics implicates music publishers; "match + snippet" mitigates but does not
  eliminate it. LRCLIB's own usage expectations also apply at service scale
  (shared cache to minimize load — see §7).
- **You become a data controller** (GDPR/CCPA) the moment you host user data,
  regardless of source. Required: privacy policy, EULA with Spotify-mandated
  clauses (Terms V.11 — disclaim warranties for Spotify, name Spotify a
  third-party beneficiary, etc.), working **disconnect + delete** flow, data
  retention limits, encryption of stored tokens, cookie/consent banner.
- **Ads intersect privacy.** Ad networks (e.g. AdSense) have content policies a
  lyrics site may be scrutinized under, and ad tracking triggers consent
  obligations under GDPR/ePrivacy.

## 6. Core architecture decision: shared core + storage adapters

**The linchpin.** Extract all domain logic into a framework- and
storage-agnostic **`core`** package. Editions differ only in their **storage
adapter** and their **host** (Express+SQLite vs API+Postgres). This is what
stops the two editions from drifting.

```
core (pure logic, no DB, no HTTP)
  ├─ matching   normalize / cleanTitle / matchKey
  ├─ ingest     export-JSON parsing, Web-API normalization → canonical songs
  ├─ lyrics     LRCLIB client, backoff, status classification
  ├─ search     query building, stemming rules, snippet + occurrence counting
  └─ spotify    OAuth + Web API client (search, playlist)

StorageAdapter interface  (implemented twice)
  ├─ SqliteAdapter    → Personal Edition
  └─ PostgresAdapter   → Hosted Service
```

## 7. Hosted-service data model (multi-tenant, scalable)

Key insight: **lyrics are identical for everyone**, so store them **once**,
globally, keyed by canonical song — a huge win for storage and for LRCLIB load.
Per-user data is only "which songs this user has, and their play counts."

```
songs            (GLOBAL, shared across all users)
  id, match_key (unique), artist, title, album,
  spotify_uri, lyrics_status, lyrics_snippet_index (tsvector), fetched_at

user_songs       (PER-USER)
  user_id, song_id, in_library, play_count, ms_played, playlists (jsonb)
  PK (user_id, song_id)

users
  id, email, created_at, ...

spotify_accounts (PER-USER, encrypted at rest)
  user_id, spotify_user_id, access_token, refresh_token, expires_at, scopes

sessions         (or Redis)
```

- **Search** = Postgres FTS (`tsvector`, stemming) on global `songs` joined to
  `user_songs` filtered by `user_id`. Consider Meilisearch/Typesense if FTS
  becomes a bottleneck.
- **Shared lyric fetch**: a global worker fetches each unknown song once; all
  users benefit. Never fetch per-user.

## 8. Scalability plan

- **Stateless app servers** behind a load balancer; sessions/tokens in
  Postgres/Redis so any node can serve any request.
- **Separate web from workers.** Ingest (parse upload / pull API) and lyric fetch
  are async jobs on a queue (**pg-boss** to start — no Redis needed — or BullMQ
  later). Never block a request on a 15-minute fetch.
- **Shared lyrics cache** collapses external calls across the whole user base.
- **Rate-limit** LRCLIB and Spotify centrally (respect Retry-After; global pool).
- **Redis cache** for hot searches / top-words; **CDN** for static frontend.
- **Encrypt** Spotify refresh tokens at rest; principle of least data.
- Index `user_songs.user_id`, `songs.match_key`, the FTS column.

## 9. Proposed folder structure (open-core monorepo)

```
<repo>/
├── packages/
│   └── core/                 shared domain logic (see §6) — no DB, no HTTP
│       ├── src/{matching,ingest,lyrics,search,spotify}/
│       └── package.json
├── apps/
│   ├── personal/             OSS self-hosted edition (today's app)
│   │   ├── src/              Express host + SqliteAdapter
│   │   ├── frontend/         simple static UI
│   │   ├── Dockerfile
│   │   └── README.md
│   └── web/                  hosted SaaS
│       ├── api/              HTTP API + PostgresAdapter
│       ├── worker/           background jobs (ingest, lyric fetch)
│       ├── frontend/         SPA or SSR app (framework TBD)
│       ├── migrations/       Postgres schema
│       └── infra/            Docker/compose/IaC, deploy config
├── docs/
│   ├── PROJECT_PLAN.md       this file
│   ├── ARCHITECTURE.md       adapter interface, sequence diagrams
│   ├── DATA_MODEL.md         schema + migration detail
│   └── LEGAL.md              terms, privacy, EULA, ad-compliance checklist
├── package.json              workspaces
└── README.md
```

**Repo-visibility is an open question (§11).** Options: (a) two repos — public
`personal` + private `web`, sharing `core` as a versioned package; (b) one public
open-core monorepo (commercial edge visible); (c) private monorepo mirrored to a
public "personal" repo via CI. Recommendation leans (a) or (b).

## 10. Phased roadmap

- **Phase 0 — Refactor (no behavior change).** Extract `core` from current code;
  Personal Edition becomes `apps/personal` on the `SqliteAdapter`. First public
  commit.
- **Phase 1 — SaaS core, no Spotify.** Postgres schema, multi-tenancy, upload
  intake, search + snippet, accounts. Lowest-risk, fully useful, no API
  dependency.
- **Phase 2 — Spotify connect (opt-in).** OAuth login/connect, instant Web-API
  data pull, playlist creation. Register SDA; **apply for Extended Access**.
- **Phase 3 — Monetization & polish.** Ads + consent stack, privacy policy /
  EULA, disconnect+delete flow, retention.
- **Phase 4+ — More features** (see §12).

## 11. Open questions for the planning chat

1. **Repo strategy** — two repos vs open-core monorepo vs mirrored (§9)?
2. **Frontend framework** for the SaaS — SPA (React/Svelte) vs SSR
   (Next/SvelteKit)? Personal Edition can stay static.
3. **Auth model** — Spotify-as-login vs own accounts (email/passwordless) with
   optional Spotify connect (needed so upload-only users can exist)?
4. **Search tech** — Postgres FTS to start, or a dedicated engine
   (Meilisearch/Typesense) from the outset?
5. **Job queue** — pg-boss (no Redis) vs BullMQ (Redis)?
6. **Hosting/deploy target** — VPS, Fly.io, Railway, Render, AWS...?
7. **Ad network + consent** stack; any premium/ad-free tier later (billing)?
8. **Product name / domain.**

## 12. Feature backlog (ideas, unprioritized)

Search by phrase/regex; filter by mood/era/artist; "songs about X" thematic
playlists; lyric-word analytics ("your most-sung words"); shareable public
playlists; multi-language lyric support; recommendations from lyric themes;
Wrapped-style yearly lyric report; collaborative playlists.

---

_Last updated: 2026-07-27._
