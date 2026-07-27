#!/bin/sh
# Runs once every time the container starts, before the server.
set -e

# 1. Make sure a .env exists so dotenv has something to read. Without real
#    Spotify credentials the app still runs — only playlist creation is disabled.
if [ ! -f /app/Backend/.env ]; then
  echo "[entrypoint] no .env found — copying from .env.example"
  echo "[entrypoint] edit Backend/.env and add your Spotify credentials to enable login"
  cp /app/Backend/.env.example /app/Backend/.env
fi

# 2. Build the database from the user's export on first run only. The long
#    lyrics fetch is left as a manual step (docker compose exec app npm run lyrics)
#    so startup isn't blocked for ~15 minutes.
if [ ! -f /app/Data/spotify.db ]; then
  echo "[entrypoint] no database found — running ingest from /app/Data ..."
  node src/ingest.js || echo "[entrypoint] ingest skipped (is your Spotify export in Data/?)"
  echo "[entrypoint] tip: run 'docker compose exec app npm run lyrics' to fetch lyrics"
fi

exec "$@"
