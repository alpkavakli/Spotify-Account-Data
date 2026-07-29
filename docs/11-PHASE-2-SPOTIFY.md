# 11 — Phase 2: Spotify connect (hosted)

**Goal:** a signed-in user *optionally* connects their Spotify account, and gets
two things Phase 1 cannot give them — their library and playlists without
uploading anything, and playlists created back on their account from a lyric
search.

**Not started.** This document is the plan and the research; the only code that
exists is `apps/web/src/token-crypto.js` (below). Phase 2 has a hard prerequisite
that is not code — see §1 — so it is written down now so that the day the
credentials exist, the work is mechanical.

## 1. Prerequisites, none of which are code

1. **Register a Spotify Developer application.** Nothing here can be run
   end to end without a client id and secret. The Personal Edition's OAuth code
   has existed since Phase 0 and **its network round-trip has still never been
   executed** — it is tested against a fake.
2. **Redirect URIs registered exactly**, including the production one. Spotify
   matches them literally.
3. **Apply for extended quota.** A new app is limited to a small number of
   manually-added users (25, last time this was checked — verify, Spotify has
   changed this more than once). That is enough for an invite-only launch and
   not enough for a public service.

### The thing to check before building any of it

**Spotify's Developer Terms restrict what you may do commercially with their
platform, and this product is ad-supported.** That combination is the single
biggest risk in Phase 2 and it is a legal question, not an engineering one. Read
the current Developer Terms and Design Guidelines end to end — specifically what
they say about advertising, about monetisation, and about attribution — before
writing the extended-quota application, and preferably before writing the code.

Do not take the summary above, or anything else in this document, as a statement
of what Spotify's terms currently say. They change, and the consequence of being
wrong is the API access being withdrawn.

This is also exactly why Phase 1 was built first and built to be complete on its
own: if Spotify says no, the service still works. **Nothing in Phase 2 may become
load-bearing for Phase 1's features.**

## 2. What connecting actually gives you — and what it does not

Worth being precise about, because it is easy to assume "connect Spotify" makes
the export upload obsolete. It does not.

| Data | Web API | The export upload |
|---|---|---|
| Saved tracks (library) | ✅ `/me/tracks` | ✅ |
| Playlists | ✅ `/me/playlists` | ✅ |
| Top tracks/artists | ✅ `/me/top/*` | derived from history |
| Genres | ✅ (via artists) | ❌ never present |
| **Long-term play counts / listening history** | ❌ | ✅ **the only source** |
| Recent plays | ⚠️ `/me/player/recently-played` — **last 50 only** | — |

**The upload stays the only way to get listening history.** The API has no
endpoint for it; `recently-played` is a 50-item window, which is why the lyrical
summary in `07-FUTURE-FEATURES.md` needs polling *and* a new play-events table
rather than a query.

So Phase 2 is additive: connect for convenience, genres and playlist creation;
upload for the history that makes the stats interesting. The UI has to say this,
or connected users will wonder why their stats look thin.

## 3. What already exists

`packages/core/src/spotify.js` is **stateless by design** — every function takes
the credentials or token it needs, and there is no storage, no env and no `this`.
That was done in Phase 0 precisely so the hosted edition could reuse it, and it
means Phase 2 adds a host, not a client:

| Have | Need |
|---|---|
| `authorizeUrl`, `exchangeCode`, `refreshAccessToken` | per-user storage + refresh orchestration |
| `getMe`, `searchTrackUri`, `createPlaylist`, `addTracks` | library/playlist pull endpoints (`/me/tracks`, `/me/playlists`) |
| 429 back-off, 401 → `NO_AUTH` | per-user rate-limit budgeting |

`core` does not change (Open/Closed). New endpoints are additions to the same
stateless module; everything per-user lives in `apps/web`.

## 4. Token storage

Migration `002_spotify.sql` (**not written yet** — migrations are immutable once
applied, so it lands with the code that uses it, not before):

```sql
CREATE TABLE spotify_accounts (
  user_id           BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  spotify_user_id   TEXT        NOT NULL,
  access_token_enc  TEXT        NOT NULL,
  refresh_token_enc TEXT        NOT NULL,
  scopes            TEXT[]      NOT NULL,
  expires_at        TIMESTAMPTZ NOT NULL,
  connected_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

`ON DELETE CASCADE` from `users(id)` is the same discipline as every other
per-user table (`06-DATA-MODEL.md`): `DELETE FROM users WHERE id = $1` stays one
statement and erasure cannot rot as tables are added.

`scopes` is stored because the set will grow. A user who connected before a
feature existed has not granted its scope, and the app needs to know that without
asking Spotify.

### Encryption — done, and tested

`apps/web/src/token-crypto.js`, 29 tests, no database.

A refresh token is a long-lived key to somebody's Spotify account. In the hosted
service they sit in one table for every user at once, and `deploy/backup.sh`
copies that table off the box nightly. Plaintext, one leaked backup is every
connected user's account — not "their data in our service", their account, on a
service we do not run.

- **AES-256-GCM**, random 96-bit IV per encryption, key from the environment.
- **The user id is the AAD**, so a token blob lifted from one row into another
  fails loudly instead of decrypting into the wrong account.
- **A keyring, not a key** — `TOKEN_ENCRYPTION_KEYS="2:…,1:…"`, first key
  encrypts, the rest still decrypt. Rotation is "prepend a key and redeploy"
  rather than a re-encrypt migration run under pressure.
- **No default and no development fallback.** Every other fallback in this
  codebase degrades to something visibly wrong; a default encryption key
  degrades to something indistinguishable from working, and would end up being
  the key in production.

What it does not defend against: an attacker who owns the running process, who
has the key. The threat it answers is the realistic one — a dump, a backup, a
snapshot, an over-broad `SELECT` in a support script.

The Personal Edition deliberately does not encrypt. Its SQLite file is on the
user's own machine and the key would live beside it.

## 5. The OAuth flow, multi-tenant

The single-user Personal Edition can keep one `state` in memory. The hosted one
cannot: `state` is a CSRF defence and has to be **bound to the session that
started the flow**, stored server-side, single-use, and short-lived. A `state`
that is merely random and unchecked lets an attacker complete a connect flow into
*their* Spotify account against *your* session.

```
GET  /auth/spotify           → 302 to Spotify, state stored against the session
GET  /auth/spotify/callback  → verify state, exchange code, encrypt, store
POST /auth/spotify/disconnect
```

`/auth/*` already reaches the API through both Caddy and the Next rewrite
(`deploy-routes.test.js` holds them together), so the callback path needs no new
routing.

**Scopes.** Request the minimum, and be aware that Spotify's consent screen lists
every one of them — a long list measurably costs connections:

- `user-library-read`, `playlist-read-private`, `playlist-read-collaborative` — the pull
- `user-top-read`, `user-read-recently-played` — stats and, later, the summary
- `playlist-modify-public`, `playlist-modify-private` — playlist creation

**Disconnecting deletes our copy of the tokens and nothing else.** As far as is
known Spotify offers no programmatic revocation, so the disconnect UI must also
tell the user to remove the app at their Spotify account page. Saying "you have
been disconnected" while an authorised grant still exists on their account would
be a lie.

**All pulls go through the queue** (`02-SCALABILITY.md`): a library pull is
minutes of paginated requests and must never happen inside a web request.

## 6. Step sequence

Each step is one commit; the user commits.

1. **`spotify_accounts` + migration `002`** — schema, adapter methods, tested
   against real Postgres like everything else in `apps/web`.
2. **Connect / callback / disconnect routes** — with a fake Spotify, exactly as
   `apps/personal/test/helpers/fake-spotify.js` already does. This is the step
   where `state` handling gets its own tests.
3. **Token refresh** — lazily on use, plus `needsRotation()` sweeps. A 401 from
   Spotify means re-connect, and the UI has to say so rather than silently
   failing.
4. **Library + playlist pull**, as a pg-boss job, feeding the same
   `upsertSongs()` path the upload uses. Same songs table, same global lyrics.
5. **Playlist creation from a search** — `searchTrackUri` + `createPlaylist` +
   `addTracks` already exist; this is a route, a job and a UI.
6. **The frontend** — a connect button, a connected state, an honest explanation
   of what connecting does and does not fetch (§2).

## 7. Rules held throughout

- **`core` does not change.** New endpoints are stateless additions.
- **Phase 1 keeps working with Spotify switched off entirely.** Every Phase 2
  feature is behind "is this user connected", and the answer being "no" is a
  normal state, not an error.
- **Every token is encrypted before it reaches a column**, with the user id as
  context.
- **Nothing that talks to Spotify runs inside a web request.**
- **The API refuses to start in production without `TOKEN_ENCRYPTION_KEYS`** —
  the same tripwire pattern as the mailer and `BASE_URL` (`08-DEPLOYMENT.md`).
  To be wired in step 1, when something actually stores a token.

## Status

- [x] Token encryption at rest (`token-crypto.js`, 29 tests)
- [ ] Step 1 — `spotify_accounts` + migration `002`
- [ ] Step 2 — connect / callback / disconnect
- [ ] Step 3 — token refresh
- [ ] Step 4 — library + playlist pull
- [ ] Step 5 — playlist creation
- [ ] Step 6 — frontend

**Blocked on §1.** Steps 1–6 can all be built and tested against a fake, as the
Personal Edition's Spotify code already is. What cannot be done without a
registered app is the only thing that has ever mattered here: running the real
network flow once and finding out what the fake got wrong.
