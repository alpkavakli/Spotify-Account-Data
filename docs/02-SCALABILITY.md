# 02 — Scalability Plan (and why not Kubernetes yet)

**Guiding idea:** you scale by *architecture* (statelessness, a job queue, a shared
cache, good indexes), not by *infrastructure* (Kubernetes). The architectural
choices below cost nothing now and let a single modest VPS serve thousands of users,
then let you scale out by running more copies — without a rewrite.

## Why NOT Kubernetes (now, and probably for a long time)

Kubernetes orchestrates many containers across many machines with auto-scaling and
self-healing — a problem we don't have. It carries a near-full-time ops burden, which
contradicts the two things we decided: **VPS/DIY** and **"coder, not infra person."**
For an **invite-only launch (Spotify Dev Mode, ≤25 users)** it is massive overkill.
Even later, managed options (Fly.io, Railway autoscale, or *managed* K8s) beat
self-hosted K8s for a small team. K8s is rung 7 below — reached only with a fleet and
a team, if ever.

## The scaling ladder — add each rung only when a metric forces it

| Rung | Add | Trigger |
|------|-----|---------|
| **0 — now** | 1 VPS, Docker Compose, Postgres, Caddy (auto-HTTPS), pg-boss worker | Launch |
| **1** | Cloudflare in front (free CDN + DDoS shield + edge cache) | ~Day one (it's free) |
| **2** | Bigger VPS (vertical scaling) | CPU/RAM consistently > 70% |
| **3** | Redis (hot-search cache, sessions, central rate-limit token bucket) | Repeated searches hammer Postgres |
| **4** | PgBouncer (connection pooling) + index review | Postgres connection limits / slow queries |
| **5** | 2+ app containers behind Caddy load-balancing | One box maxed even when large |
| **6** | Managed Postgres or a read replica | DB is the bottleneck; want backups/failover off your plate |
| **7** | *Maybe* container orchestration | Fleet across many machines, with a team — and even then prefer managed |

## The stack (deliberately boring)

Docker Compose · Postgres · Redis (later) · Caddy · Cloudflare · S3-compatible object
storage. All operable by one person.

## Two additions to PROJECT_PLAN §8 (cheap now, painful to retrofit)

1. **Object storage for uploads (S3-compatible).** GDPR export uploads can be tens of
   MB. Never store them on the app server's disk or in Postgres — put them in object
   storage (self-hosted **MinIO** on the VPS, or **Cloudflare R2** = no egress fees).
   Keeps app servers truly stateless, which rung 5 depends on.
2. **Cloudflare from the start.** Free tier = CDN + DDoS protection + an edge cache in
   front of the single VPS. Punches far above its (zero) cost.

## Bake in NOW vs. defer

**Bake in from day one (architectural — cheap now, expensive later):**
- Stateless app (sessions/tokens in Postgres/Redis, never in process memory).
- Every per-user table keyed by `user_id`; global shared `songs` + lyrics table.
- ALL slow work (ingest, lyric fetch) goes through the queue — never inline in a request.
- Uploads → object storage (no local-disk assumptions in logic).
- Config via env vars (12-factor); a real DB-migrations tool.

**Defer (bolt on by trigger above):** Redis, PgBouncer, multiple nodes, orchestration.

**Bottom line:** the architecture is what scales. The infra stays small and boring on
purpose, so one person can run it through rung 6 without Kubernetes.
