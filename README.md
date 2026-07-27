# Lyric Search

Search your own Spotify listening history **by the words in the lyrics**, then
turn any search into a real Spotify playlist.

Ask "which of my songs mention _door_?" and get every matching track across your
library, playlists, and streaming history — with the lyric line highlighted.
Tick the ones you want and it builds the playlist on your Spotify account.

> Your Spotify export is **personal data and is never committed** to this repo.
> The `apps/personal/Data/` folder ships empty; you drop your own export into it
> locally.

## How it works

- **`ingest`** reads your Spotify export JSON (`apps/personal/Data/`) into a local
  SQLite database, merging library + playlists + streaming history into one row per song.
- **`lyrics`** fetches lyrics for every song from [LRCLIB](https://lrclib.net)
  (free, no API key) and indexes them with SQLite FTS5 full-text search.
- **`start`** serves a small web UI and a `/searchForWord` API. Search uses a
  porter stemmer, so `door` also matches `doors`.
- **Playlist creation** logs into Spotify via OAuth and, because most exported
  rows have no track URI, looks the missing ones up through Spotify's Search API.

## Requirements

- **Node.js 24+** (the app uses the built-in `node:sqlite` module, which needs
  Node 24 to run without an experimental flag), **or** Docker.
- A free **Spotify Developer app** — only needed for playlist creation, not for
  searching. See [Spotify setup](#spotify-setup-for-playlist-creation) below.

## Quick start (local)

```bash
# 1. Get your Spotify data and put the JSON in apps/personal/Data/
#    →  see apps/personal/Data/README.md
# 2. From the repo root (npm workspaces; the root scripts delegate to the app):
npm install
npm run ingest        # builds apps/personal/Data/spotify.db (seconds)
npm run lyrics        # fetches + indexes lyrics (~10-15 min, one time)
npm start             # http://127.0.0.1:3000
```

`npm run setup` runs `ingest` then `lyrics` in one go.

## Quick start (Docker)

```bash
# Put your Spotify JSON in apps/personal/Data/ first
# (see apps/personal/Data/README.md), then from apps/personal/:
cd apps/personal
docker compose up --build                # http://127.0.0.1:3000
docker compose exec app npm run lyrics   # fetch lyrics (one time, ~15 min)
```

The container mounts `./Data` from the host, so your data and the generated
database stay on your machine. On first start it copies `.env.example` to
`.env` and runs `ingest` automatically.

## Spotify setup (for playlist creation)

Searching works without this. To build playlists you need OAuth credentials:

1. Open the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)
   and click **Create app**.
2. Set the **Redirect URI** to exactly:

   ```
   http://127.0.0.1:3000/callback
   ```

   Spotify rejects `http://localhost` — it must be the loopback IP `127.0.0.1`.
3. Enable **Web API**, save, and copy the **Client ID** and **Client Secret**.
4. In `apps/personal/`, copy `.env.example` to `.env` and paste them in:

   ```bash
   cp apps/personal/.env.example apps/personal/.env
   ```

5. Restart the server and click **log in with spotify** in the top-right.

### Creating a playlist

1. Search for a word.
2. Click **create playlist** — a checkbox appears next to every result, all ticked.
3. Untick any songs you don't want.
4. Click **continue**, give the playlist a name, choose public/private, and **create**.

Songs with no Spotify URI in your export are looked up automatically; any that
still can't be found are listed so you know what was skipped.

## Project structure

An npm-workspaces monorepo. Domain logic lives in a shared, storage-agnostic
`core` package; the Personal Edition is a thin host over it on a SQLite adapter.

```
.
├── packages/
│   └── core/             shared domain logic — no DB, no HTTP
│       └── src/
│           ├── matching.js   normalize / cleanTitle / matchKey
│           ├── ingest.js     export JSON  →  canonical songs (pure merge)
│           ├── lyrics.js     LRCLIB client + status classification
│           ├── search.js     FTS query build, occurrence + top-word counting
│           ├── spotify.js     stateless OAuth + Web API client
│           └── storage.js     the StorageAdapter contract
├── apps/
│   └── personal/         OSS self-hosted edition (Express + SQLite)
│       ├── src/
│       │   ├── server.js         HTTP API + routes
│       │   ├── ingest.js         CLI: export JSON  →  spotify.db
│       │   ├── lyrics.js         CLI: lyric fetch + FTS index
│       │   ├── spotify.js        token-storage glue over core/spotify
│       │   ├── sqlite-adapter.js StorageAdapter impl (all SQL lives here)
│       │   └── store.js          the single adapter instance
│       ├── frontend/     Static web UI (index.html)
│       ├── Data/         Your Spotify export goes here (git-ignored, empty in repo)
│       ├── Dockerfile · docker-compose.yml · .env.example
│       └── package.json
├── docs/                 planning + architecture docs (start at docs/00-INDEX.md)
└── package.json          workspaces root
```

## Privacy

`.gitignore` keeps all of these out of version control: your export JSON, the
generated `spotify.db`, your `.env` secrets, and local editor config. Only the
code is tracked.

## Notes / limitations

- Lyric coverage is roughly 90% — sped-up edits and some non-English tracks
  aren't on LRCLIB and come back as `notfound`.
- The lyrics fetch is polite to the free API (throttled + retried with backoff);
  the one-time run takes 10–15 minutes.
