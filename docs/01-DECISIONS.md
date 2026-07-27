# 01 — Resolved Decisions & Engineering Principles

This records the answers to the open questions in `PROJECT_PLAN.md §11`, plus the
principles we build by. **Decided — do not relitigate** unless a decision is
explicitly reopened.

## Resolved decisions (2026-07-27)

| Topic | Decision | Why / notes |
|-------|----------|-------------|
| **Repo strategy** | Private monorepo is the source of truth; the public "personal" repo is a **publish target**. | Everything (`core`, `personal`, `web`) is committed & versioned in ONE private repo. The OSS Personal Edition (`core` + `apps/personal`) is later published into a separate public repo via `git subtree split` / a sync script. Commercial code never lives in the public repo's history → zero leak risk. Chosen over `.gitignore`-hiding, which leaves private code un-versioned and one mistake away from a permanent public leak. |
| **SaaS login** | Own accounts (email / passwordless) + **optional** Spotify connect. | Required so upload-only users can exist with no Spotify API. Also the fallback if Spotify revokes API access — people can still log in. |
| **SaaS frontend** | Next.js (React), server-rendered (SSR/SSG). | Good SEO for an ad-supported, traffic-dependent site. Personal Edition stays plain static HTML. |
| **Hosting** | VPS (DIY, e.g. Hetzner / DigitalOcean). | Cheapest in dollars. Ops burden mitigated with Docker Compose + Caddy (auto-HTTPS) + automated backups. Moving to Railway/Render later is easy if ops becomes a drag. |
| **Search tech** | Postgres full-text search (`tsvector`) to start. | Built-in, free, good for a long time. Swap to Meilisearch/Typesense only if it becomes a bottleneck. |
| **Job queue** | pg-boss (jobs live inside Postgres). | No extra service to run. Move to BullMQ/Redis later if needed. |

**Deferred (Phase 3 / branding):** ad network + consent stack, premium/ad-free tier,
product name + domain.

## Git workflow (hard rule)

- **The user performs ALL git commits and pushes personally.** The agent never runs
  `git commit` / `git push`. The agent provides commit-message text; the user edits
  and commits. Staging file edits is fine; the commit itself is theirs.

## Engineering principles

### SOLID (applied pragmatically in JS)
- **S — Single Responsibility:** `core` modules are split by concern
  (`matching`, `ingest`, `lyrics`, `search`, `spotify`); persistence lives only in
  storage adapters; HTTP lives only in the host. No module does two of these.
- **O — Open/Closed:** new behavior (e.g. a Postgres backend) is added by writing a
  new adapter, not by editing `core`.
- **L — Liskov Substitution:** `SqliteAdapter` and `PostgresAdapter` are fully
  interchangeable behind the `StorageAdapter` contract — the host cannot tell which
  it holds.
- **I — Interface Segregation:** the adapter contract is grouped by use
  (ingest / lyrics / search / auth) so a consumer depends only on what it uses.
- **D — Dependency Inversion:** `core` depends on the `StorageAdapter` *abstraction*,
  never on `node:sqlite` or `pg`. Adapters are injected in by the host.

### ACID (data-integrity discipline)
- **Atomicity:** multi-row writes (bulk song ingest, save-lyrics-then-index) run in a
  single transaction — all or nothing. (Today's `ingest.js` already wraps its insert
  loop in `BEGIN`/`COMMIT`; adapters must preserve this.)
- **Consistency:** invariants enforced in the schema (`match_key UNIQUE`, FK from
  `lyrics` → `tracks` with `ON DELETE CASCADE`), not just in app code.
- **Isolation:** SQLite runs in WAL mode; the Postgres adapter will use explicit
  transactions with appropriate isolation for multi-tenant writes.
- **Durability:** committed data survives a crash (WAL / Postgres fsync). Long jobs
  (lyric fetch) checkpoint progress per row so a crash never loses more than one item.

## Documentation rule
Document the process as we go, in numbered `docs/` files (see `00-INDEX.md` for the
reading order). `10-WORKLOG.md` is the append-only record of what actually happened.
