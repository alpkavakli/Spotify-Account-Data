# Documentation Index — read in this order

These docs capture the full context and process of turning the single-user Spotify
lyric-search app into a two-track product (OSS Personal Edition + hosted SaaS). They
are **numbered in reading order** so a fresh agent (or human) can get up to speed
without re-deriving anything.

| # | Doc | What it covers |
|---|-----|----------------|
| 00 | [00-INDEX.md](00-INDEX.md) | This file — reading order. |
| — | [PROJECT_PLAN.md](PROJECT_PLAN.md) | The master vision brief: what the product is, the two-track plan, legal map, data model, phased roadmap. Read this first for the "why". |
| 01 | [01-DECISIONS.md](01-DECISIONS.md) | Resolved decisions (repo strategy, auth, frontend, hosting, search, queue) and the engineering principles we hold to (SOLID, ACID). |
| 02 | [02-SCALABILITY.md](02-SCALABILITY.md) | The scaling ladder, why NOT Kubernetes (yet), and the concrete tech stack with add-it-when triggers. |
| 03 | [03-PHASE-0-REFACTOR.md](03-PHASE-0-REFACTOR.md) | The plan for extracting the shared `core` package and the `StorageAdapter` interface. **Complete.** |
| 04 | [04-TESTING.md](04-TESTING.md) | How the project is tested: the three layers, the adapter conformance suite, how to test Express routes, and how to add a test. |
| 05 | [05-PHASE-1-SAAS.md](05-PHASE-1-SAAS.md) | The plan for the hosted service on Postgres — step sequence and status. **The current active phase.** |
| 06 | [06-DATA-MODEL.md](06-DATA-MODEL.md) | The hosted service's multi-tenant Postgres schema: global songs/lyrics, per-user play data, and why each column is the type it is. |
| 07 | [07-FUTURE-FEATURES.md](07-FUTURE-FEATURES.md) | Designed but **not scheduled**. Currently: the weekly/monthly lyrical summary (embeddings, time-weighted mean, ML). Read it before starting one of them, not before Phase 1. |
| 08 | [08-DEPLOYMENT.md](08-DEPLOYMENT.md) | Running the hosted service on a VPS: Docker Compose, Caddy, the mail provider, backups, upgrades. What `deploy/` is. |
| 09 | [09-PUBLISHING.md](09-PUBLISHING.md) | Generating the public OSS Personal Edition out of this private repo: the allowlist, the AGPL licence, and what keeps commercial code out. What `tools/` is. |
| 10 | [10-WORKLOG.md](10-WORKLOG.md) | Running, append-only log of what we actually did, step by step, with results. |

**Reading order for a new agent:** `PROJECT_PLAN.md` → `01` → `02` → `03` → `04` → `05` → `06` → `10`
(then the newest entries in `10-WORKLOG.md` tell you where we are right now).
`08` and `09` are reference for when you deploy or publish, not part of the
catch-up read.

_Convention: low numbers are stable reference; `10-WORKLOG.md` grows over time.
New reference docs slot in by topic (e.g. `04-DATA-MODEL.md`, `05-LEGAL.md`)._
