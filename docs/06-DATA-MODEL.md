# 06 — Hosted-service data model

The multi-tenant Postgres schema, and why it is shaped this way. The SQL itself
is [`apps/web/migrations/001_init.sql`](../apps/web/migrations/001_init.sql),
which is commented and meant to be read.

## The one idea

**Lyrics are the same for everybody.** A song's words do not depend on who
listened to it. So songs and lyrics are stored **once, globally**, and the only
per-user data is *"which songs this user has, and how often they played them."*

```
        GLOBAL (shared by every user)          PER-USER
        ┌──────────────┐                       ┌──────────────┐
        │ songs        │◄──────────────────────│ user_songs   │──┐
        │  match_key ∪ │                       │  play_count  │  │
        │  artist      │                       │  stream_count│  │
        │  track       │                       │  ms_played   │  │
        │  uri         │                       │  in_library  │  │
        └──────┬───────┘                       │  playlists   │  │
               │ 1:1                           └──────────────┘  │
        ┌──────▼───────┐                       ┌──────────────┐  │
        │ lyrics       │                       │ user_meta    │  │
        │  status      │                       │ sessions     │  │
        │  body        │                       │ spotify_accts│  │
        │  body_tsv ⚡ │                       │ uploads      │  │
        └──────────────┘                       └──────┬───────┘  │
                                                      │          │
                                               ┌──────▼──────────▼┐
                                               │ users            │
                                               └──────────────────┘
                                                 everything cascades from here
```

Two consequences, both large:

- **Storage stays flat.** The thousandth user who owns *Bohemian Rhapsody* adds
  one narrow `user_songs` row, not another copy of the lyrics.
- **LRCLIB is asked about each song exactly once**, ever, across the entire user
  base. At scale this is the difference between being a good citizen of a free
  service and being the reason it starts rate-limiting.

The lyric fetch worker is therefore **global, not per-user**: it walks songs that
have no lyrics yet, regardless of who owns them.

## Tables

| Table | Scope | Purpose |
|---|---|---|
| `users` | — | one row per account (email + display name) |
| `login_tokens` | — | passwordless sign-in; stores a **SHA-256, never the token** |
| `sessions` | per-user | server-side sessions, so any app node can serve any request |
| `songs` | **global** | the canonical catalogue, keyed by `match_key` |
| `lyrics` | **global** | 1:1 with `songs`; holds the body and the search index |
| `user_songs` | per-user | play counts, listens, library flag, playlist names |
| `user_meta` | per-user | dataset facts: history coverage window, skip threshold |
| `spotify_accounts` | per-user | optional Spotify connection (Phase 2) |
| `uploads` | per-user | export uploads awaiting/undergoing processing |

## Decisions worth knowing

### `body_tsv` is a GENERATED column

```sql
body_tsv tsvector GENERATED ALWAYS AS
  (to_tsvector('english'::regconfig, coalesce(body, ''))) STORED
```

**The one place the Postgres design is strictly better than SQLite's.** In
`SqliteAdapter.saveLyrics` the app has to `DELETE FROM lyrics_fts` and re-`INSERT`
by hand; forget it once and search returns songs whose lyrics no longer exist.
Here the index is a *function of the column*, recomputed by Postgres on every
write. There is no index-maintenance code to forget, and no way to drift.

It also handles the awkward case for free: when a re-fetch turns a hit into a
miss, `body` becomes `NULL`, the tsvector becomes empty, and the song silently
stops matching.

(`'english'` is written as an explicit `regconfig` because the one-argument
`to_tsvector()` is only `STABLE` — it reads a session setting — and a generated
column requires `IMMUTABLE`.)

### `in_library` is `smallint`, not `boolean`

The `StorageAdapter` contract says `in_library` is `0|1` and the routes do
`!!row.in_library`. A boolean column would come back from node-postgres as
`true`/`false` and break the contract `SqliteAdapter` already satisfies. The
conformance suite asserts `typeof === "number"`, so this would have failed in
Step 4 — the column type is chosen to satisfy the contract, not the other way
round.

### `ms_played` is `bigint`

One real user has **3.7 × 10⁹ ms** of listening in a single year. `int4` stops at
2.1 × 10⁹. This is not a hypothetical headroom argument.

### Deleting a user is a single `DELETE`

Every per-user table is `REFERENCES users(id) ON DELETE CASCADE`. GDPR erasure is
therefore `DELETE FROM users WHERE id = $1` — not a cleanup routine that someone
has to remember to extend every time a table is added. The global catalogue is
deliberately *not* touched: other users still need those songs.

### Login tokens are stored hashed

`login_tokens.token_hash` is `bytea` and holds a SHA-256. A leaked database dump
must not be a set of working login links.

### Emails are `citext`

`Alp@Example.com` and `alp@example.com` are one account. Without it, a
passwordless login link silently creates a second account for the same person.

## Known issue for Step 4: `bigint` arrives as a string

`node-postgres` returns `int8` as a **string** (to avoid silent precision loss
past 2⁵³). The conformance suite requires numbers — the routes do arithmetic on
these — so `PostgresAdapter` must cast in SQL (`ms_played::float8`) or register a
type parser. Recorded here because it is exactly the kind of difference the
conformance suite exists to catch, and it is already known before the adapter is
written.

## Migrations

Forward-only, plain `.sql`, applied in filename order by
[`apps/web/src/migrate.js`](../apps/web/src/migrate.js) (~80 lines, no framework):

- each file runs in **one transaction** — Postgres has transactional DDL, so a
  failure leaves the database exactly as it was
- applied migrations are recorded in `schema_migrations` with a **checksum**;
  editing an applied migration is refused, because the database and the repo
  would otherwise silently disagree about what the schema is
- a **session advisory lock** wraps the run, so booting two app servers at once
  migrates once and the other waits
- there are no `down` migrations: a rollback that drops a column is a data-loss
  button that looks like an undo button. Fix forward.

```bash
npm run db:up   --workspace @lyricsearch/web   # start Postgres (docker, port 5433)
npm run migrate --workspace @lyricsearch/web   # apply migrations
npm test        --workspace @lyricsearch/web   # 45 tests against real Postgres
```

The tests run against a **real** Postgres, never a mock — the entire point is to
find out how Postgres behaves, not to confirm what we imagined. If Postgres is
not running they **skip with an explanation** rather than fail, so `npm test` at
the repo root stays green for someone working only on the Personal Edition.
