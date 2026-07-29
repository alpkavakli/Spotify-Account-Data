#!/bin/sh
# Dump the database. Run it from cron on the server; see docs/08-DEPLOYMENT.md.
#
#   ./backup.sh                   → ./backups/lyricsearch-<utc timestamp>.sql.gz
#   BACKUP_DIR=/mnt/vol ./backup.sh
#   KEEP_DAYS=30 ./backup.sh
#
# What is worth backing up, and what is not:
#
#   Postgres  — everything. Accounts, sessions, every user's play history, and
#               the whole global lyric catalogue. Losing it loses the service.
#   blobs     — the original uploaded zips. NOT backed up here. They are already
#               parsed into Postgres, so they restore nothing; they exist so an
#               upload can be re-parsed after a bug. Losing them costs users a
#               re-upload, not their data. Add them if that trade changes.
#   caddy_data — certificates. Not backed up: Caddy re-issues on a new box in
#               seconds. Do not delete it casually on a *running* box, though —
#               Let's Encrypt rate-limits re-issuance.
#
# `pg_dump` runs inside the container, so this needs no Postgres client on the
# host and no published database port.

set -eu

cd "$(dirname "$0")"

BACKUP_DIR="${BACKUP_DIR:-./backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"

stamp=$(date -u +%Y%m%dT%H%M%SZ)
out="$BACKUP_DIR/lyricsearch-$stamp.sql.gz"

mkdir -p "$BACKUP_DIR"

# -T: no TTY, or the dump gets carriage returns spliced into it and restores as
# a corrupt file — which you find out on the day you need it.
docker compose exec -T postgres \
	pg_dump --username=lyricsearch --format=plain --no-owner lyricsearch |
	gzip -9 >"$out.part"

# Written under .part and renamed, so a dump interrupted half way through never
# leaves a truncated file that looks like a good backup.
mv "$out.part" "$out"

# A zero-length or absurdly small dump means pg_dump failed while gzip happily
# succeeded. Better to fail the cron job loudly than to keep 14 days of nothing.
size=$(wc -c <"$out")
if [ "$size" -lt 1024 ]; then
	echo "backup.sh: $out is only $size bytes — treating as a failure" >&2
	exit 1
fi

find "$BACKUP_DIR" -name 'lyricsearch-*.sql.gz' -mtime "+$KEEP_DAYS" -delete

echo "backup.sh: wrote $out ($size bytes); keeping $KEEP_DAYS days"

# NOTE: this leaves the backups on the same disk as the database, which protects
# against `DROP TABLE` and not against losing the box. Copy them off — the
# provider's object storage, or `rclone`/`restic` to anywhere else. See
# docs/08-DEPLOYMENT.md §Backups.
