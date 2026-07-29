# 08 — Deploying the hosted service

Phase 1 on one VPS: Docker Compose, Caddy for automatic HTTPS, Postgres, and the
two Node processes. Rung 0 of `02-SCALABILITY.md`, which is where this stays
until a metric forces the next rung.

**Phase 1 needs nothing from Spotify.** No Developer app, no Extended Access, no
review. Upload your export, search it by lyric, see your stats — all of it works
with an account and a file. That is why this is deployable now and why it was
built in this order.

Everything below lives in [`deploy/`](../deploy/).

## What runs

| Service | Image | Job | Published |
|---|---|---|---|
| `caddy` | `caddy:2-alpine` | TLS, and the single origin the browser sees | **80, 443** |
| `web-ui` | built from `apps/web-ui/Dockerfile` | Next.js, server-rendered pages | no |
| `api` | built from `apps/web/Dockerfile` | The HTTP API. **Runs migrations on boot.** | no |
| `worker` | the same image, `node src/worker.js` | Parses uploads, fills the lyric catalogue | no |
| `postgres` | `postgres:17-alpine` | Everything. Data, sessions, and the pg-boss queue | no |

Only Caddy publishes a port. The rest talk over the private compose network, so
the box's attack surface is 80 and 443 rather than five services that are "only
bound to localhost, probably".

```
        :443
          │
     ┌────▼─────┐   /api/*   ┌──────┐        ┌──────────┐
     │  caddy   ├───────────►│ api  ├───────►│          │
     │          │   /auth/*  └──────┘        │ postgres │
     │          │                            │          │
     │          │   /*       ┌────────┐      │  + queue │
     │          ├───────────►│ web-ui ├─────►│          │
     └──────────┘            └────┬───┘      └────▲─────┘
                                  │               │
                    server components call api ───┘
                    directly over the network   ┌──────────┐
                                                │  worker  │
                                                └──────────┘
```

`/api` and `/auth` go straight to the API rather than through Next's equivalent
rewrites: one hop fewer, and it keeps a 200 MB upload body out of a Node proxy
that has no reason to touch it. **That is a second copy of the routing table** —
`deploy/Caddyfile` and `apps/web-ui/next.config.mjs` — so
`apps/web-ui/test/deploy-routes.test.js` fails if the two ever disagree.

## Before you start

Three things, none of which are code:

1. **A VPS.** Hetzner or DigitalOcean; 2 GB RAM is comfortable for Phase 1.
   Docker and the compose plugin installed.
2. **A domain**, with an A record (and AAAA if the box has IPv6) already pointing
   at it. Caddy proves control of the name over port 80 to get a certificate, so
   DNS has to be live *before* the first `up`.
3. **A transactional-email provider.** Resend, Postmark, SES, Mailgun — any of
   them, they all speak SMTP. **This is not optional**: passwordless sign-in is
   the entire login system, and the API refuses to start in production without
   it. Verify your sending domain and set up SPF and DKIM in the provider's
   dashboard; sign-in mail that lands in spam is sign-in that does not work.

## First deploy

```bash
git clone <this repo> lyricsearch && cd lyricsearch/deploy
cp .env.example .env
chmod 600 .env
$EDITOR .env                      # every value is explained in the file
docker compose up -d --build      # first build takes a few minutes
docker compose logs -f            # watch it come up
```

Then, in order:

```bash
curl -sI https://your-domain/            # 200, and a valid certificate
curl -s  https://your-domain/api/health  # {"ok":true} — the API AND its database
```

and finally sign in as yourself in a browser. **Do that before telling anyone
the address**: it is the one path that crosses every component — Caddy, Next,
the API, Postgres and your mail provider — and the only way to find out that the
email actually arrives.

### The order things start in

`docker compose up` does this for you, but it is worth knowing why:

- **postgres** first, and the others wait on its healthcheck (`pg_isready`), not
  on "the container started".
- **api** next. It runs the migrations, under a Postgres advisory lock — so
  starting several API containers at once is safe, exactly one migrates and the
  rest wait.
- **worker** and **web-ui** wait for the API's healthcheck, which is
  `/health` doing `SELECT 1`. For the worker that is not politeness: the API
  owns migrations, and a worker that started first would query tables that do
  not exist yet.
- **caddy** last.

## Configuration

All of it in `deploy/.env`, all of it documented in `deploy/.env.example`. The
three that are load-bearing:

- **`BASE_URL`** — the origin sign-in links are built from. It has to be the
  address a *browser* uses. The API defaults to `http://127.0.0.1:3001`, which
  is correct for a terminal and useless in an email, so production refuses to
  start unless you set it, and refuses again if it is not `https://`.
- **`MAIL_FROM` + `SMTP_*`** — see below.
- **`POSTGRES_PASSWORD`** — `openssl rand -base64 32`. Compose fails loudly if
  it is missing rather than starting a database with a blank password.

### Why the API refuses to start

Three boot-time checks in `apps/web/src/server.js`, all of the same kind: a
misconfiguration that would otherwise be invisible until a user hit it.

| Check | Without it |
|---|---|
| SMTP configured (`mailerFromEnv`) | Sign-in links get printed to the container log — readable by anyone with log access and by nobody trying to log in. |
| `BASE_URL` set | Links point at `127.0.0.1`. Every one of them is dead. |
| `BASE_URL` is `https://` | Session cookies are `secure`; a browser on a plaintext origin accepts the redirect and silently drops the cookie. Sign-in "works" and does nothing. |
| SMTP credentials verified (`transport.verify()`) | A wrong password shows up as the *first user's* failed login, not as your failed deploy. |

A service that will not start is an incident you notice. All four of these
otherwise become an incident your users notice.

### Mail

Any SMTP provider. Either form works:

```ini
SMTP_URL=smtp://apikey:secret@smtp.resend.com:587
```

```ini
SMTP_HOST=email-smtp.eu-west-1.amazonaws.com
SMTP_USER=AKIA...
SMTP_PASSWORD=...
```

Use the second when the password contains characters that do not survive being
parsed as part of a URL — SES SMTP passwords are base64 and routinely contain
`+` and `/`. Port 587 (STARTTLS) is assumed; 465 is detected as implicit TLS.

Changing provider later is an edit to `.env` and `docker compose up -d api`.
That portability is the reason this is SMTP and not one provider's HTTP API.

## Trying it without a domain

The whole stack, on a laptop, over plain HTTP:

```bash
cd deploy
POSTGRES_PASSWORD=trial DOMAIN=:80 \
  docker compose -f docker-compose.yml -f local-trial.yml up --build
# → http://127.0.0.1 ; sign-in links print in the api container's log
docker compose -f docker-compose.yml -f local-trial.yml logs -f api
```

`local-trial.yml` changes exactly three things, all of them consequences of
having no TLS: `NODE_ENV=development` (so the console mailer is allowed and
cookies are not `secure`), an `http://` `BASE_URL`, and a bare `:80` for Caddy
so it does not try to certify a name that does not resolve. The images, the
routing, the volumes, the healthchecks and the migration order are the ones
production uses — which is the point of it.

Tear it down with `down -v`; `-v` also deletes the trial's database.

## Upgrading

```bash
cd deploy && git pull
docker compose up -d --build
```

Rolling, in the sense that Compose replaces containers one service at a time;
there is a few seconds of 502 while the API restarts. Migrations run
automatically as the new API boots. **Take a backup first** (below) — a
migration is the one change you cannot undo by redeploying the old image.

Migrations are forward-only and immutable once applied: add `002_*.sql`, never
edit `001_init.sql`. See `06-DATA-MODEL.md`.

## Backups

`deploy/backup.sh` dumps the database through the running container, so the host
needs no Postgres client and no published port.

```bash
cd deploy && ./backup.sh              # → ./backups/lyricsearch-<utc>.sql.gz
```

From cron, daily at 03:15:

```cron
15 3 * * * cd /srv/lyricsearch/deploy && ./backup.sh >> /var/log/lyricsearch-backup.log 2>&1
```

It writes to a `.part` file and renames on success, so an interrupted dump never
leaves a truncated file that looks like a good backup, and it fails loudly if
the result is implausibly small. `KEEP_DAYS` (default 14) prunes old ones.

**This leaves the backups on the same disk as the database.** That protects you
from `DROP TABLE`, not from losing the box. Copy them off — `restic` or `rclone`
to the provider's object storage is twenty minutes of work and is the difference
between an inconvenience and the end of the service.

What is and is not backed up:

- **Postgres — everything.** Accounts, every user's play history, the whole
  global lyric catalogue, and the job queue.
- **`blobs` (the uploaded zips) — not backed up.** They are already parsed into
  Postgres and restore nothing; they exist so an upload can be re-parsed after a
  bug. Losing them costs users a re-upload, not their data.
- **`caddy_data` (certificates) — not backed up.** Caddy re-issues on a new box
  in seconds. Do not delete it casually on a *running* box, though: Let's
  Encrypt rate-limits re-issuance.

Restoring:

```bash
docker compose stop api worker
gunzip -c backups/lyricsearch-<stamp>.sql.gz | \
  docker compose exec -T postgres psql -U lyricsearch -d lyricsearch
docker compose start api worker
```

**Practise this once, on a throwaway box, before you need it.** A backup you
have never restored is a hypothesis.

## Operating it

```bash
docker compose ps                       # what is up, and what is healthy
docker compose logs -f api worker       # the two that do the work
docker compose exec postgres psql -U lyricsearch   # a database shell
docker compose restart worker           # safe: jobs are in Postgres, not in it
docker system prune -f                  # reclaim disk after a few deploys
```

Things worth knowing when something looks wrong:

- **The queue survives restarts.** pg-boss keeps jobs in Postgres, so restarting
  the worker loses nothing in flight.
- **Uploads stuck at `pending`** means the worker is down or cannot see the blob
  volume. Both containers mount the same `blobs` volume, and they have to: the
  API writes the zip, the worker reads it back.
- **`caddy` restart-looping with "wrong argument count … after 'email'"** means
  `ACME_EMAIL` is empty in `.env`.
- **Certificate failures** are almost always DNS not pointing at the box yet, or
  port 80 blocked by a firewall — Caddy needs it for the ACME challenge even
  though it only serves on 443.
- **`/api/health`** returns 503 rather than 200 when Postgres is unreachable, so
  it is a useful thing to point an uptime monitor at.

## What this deliberately does not have yet

Each is a rung on `02-SCALABILITY.md`'s ladder, to be added when a metric asks
for it and not before:

- **Cloudflare in front** — free CDN, DDoS shield, edge cache. The one item on
  that list worth doing on day one anyway.
- **Object storage for uploads.** `02-SCALABILITY.md` is right that a local disk
  makes the app stateful; a named volume is fine for one box, and moving is a
  new `BlobStore` implementation, not a rewrite (`apps/web/src/blob-store.js`).
- **Redis, PgBouncer, more than one app container.**
- **A staging environment.** `local-trial.yml` is the cheap substitute.
- **Log shipping and alerting.** Today this is `docker compose logs` and an
  uptime monitor on `/api/health`.

## Related

- `01-DECISIONS.md` — why a VPS, why Caddy, why Postgres FTS and pg-boss.
- `02-SCALABILITY.md` — the ladder, and the trigger for each rung.
- `05-PHASE-1-SAAS.md` — what is deployed here.
- `06-DATA-MODEL.md` — the schema, and the migration rules.
