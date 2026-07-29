# deploy/ — the hosted service on one box

**Read [`docs/08-DEPLOYMENT.md`](../docs/08-DEPLOYMENT.md) before the first
deploy.** This file is a map of the directory; that one is the walkthrough —
DNS, the mail provider, backups, upgrades and what to check when something looks
wrong.

| File | What it is |
|---|---|
| `docker-compose.yml` | The stack: caddy, web-ui, api, worker, postgres. Only Caddy publishes a port. |
| `Caddyfile` | TLS and routing. **The production twin of the rewrites in `apps/web-ui/next.config.mjs`** — `apps/web-ui/test/deploy-routes.test.js` fails if they drift. |
| `.env.example` | Every setting, with the reasoning. Copy to `.env` (git-ignored). |
| `local-trial.yml` | Run the whole stack on a laptop over plain HTTP, with no DNS and no mail provider. |
| `backup.sh` | `pg_dump` through the running container, for cron. |

```bash
cp .env.example .env && chmod 600 .env && $EDITOR .env
docker compose up -d --build
```

The images are built from `apps/web/Dockerfile` (the API and the worker — one
image, two commands) and `apps/web-ui/Dockerfile`. Both take the **repo root**
as their build context, because the shared `@lyricsearch/core` workspace has to
be in it.

Trying it out without a domain:

```bash
POSTGRES_PASSWORD=trial DOMAIN=:80 \
  docker compose -f docker-compose.yml -f local-trial.yml up --build
```
