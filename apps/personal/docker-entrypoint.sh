#!/bin/sh
# Runs once every time the container starts, before the server.
# WORKDIR is /app/apps/personal; the Data volume is mounted at /data.
set -e

# 1. Make sure a .env exists so dotenv has something to read. Without real
#    Spotify credentials the app still runs — only playlist creation is disabled.
if [ ! -f /app/apps/personal/.env ]; then
  echo "[entrypoint] no .env found — copying from .env.example"
  echo "[entrypoint] edit apps/personal/.env and add your Spotify credentials to enable login"
  cp /app/apps/personal/.env.example /app/apps/personal/.env
fi

# 2. Build the database from the user's export on first run only. The long
#    lyrics fetch is left as a manual step (docker compose exec app npm run lyrics)
#    so startup isn't blocked for ~15 minutes.
if [ ! -f /data/spotify.db ]; then
  echo "[entrypoint] no database found — running ingest from /data ..."
  node src/ingest.js || echo "[entrypoint] ingest skipped (is your Spotify export in Data/?)"
  echo "[entrypoint] tip: run 'docker compose exec app npm run lyrics' to fetch lyrics"
fi

exec "$@"
