#!/usr/bin/env bash
#
# Nightly backup for Konto (and the shared SendRec database, which lives in
# the same Postgres DB). Runs on the Hetzner host, not in a container.
#
# Tier 1 — local: a rotating gzipped tarball in ~/backups. Instant restore,
#   zero dependencies. Covers the most common loss events (bad migration,
#   accidental delete via the data-reset buttons).
# Tier 2 — offsite: an encrypted restic snapshot on the Hetzner Storage Box,
#   activated only once ~/services/.backup.env exists. Restic writes solely
#   inside its own repository directory, so nothing else on the box (e.g.
#   iPhoto backups) is ever touched.
#
# Schedule via cron, e.g.:
#   30 3 * * * $HOME/services/konto/scripts/server-backup.sh >> $HOME/backups/backup.log 2>&1
set -euo pipefail
export PATH="$HOME/bin:$PATH"

BACKUP_DIR="$HOME/backups"
KEEP_LOCAL=14
STAMP=$(date +%Y-%m-%d_%H%M)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"   # tarballs include .env (secrets)

# --- gather ---------------------------------------------------------------
# Whole sendrec DB → both the public (SendRec) and konto schemas.
docker exec services-postgres-1 pg_dump -U sendrec -d sendrec | gzip > "$WORK/sendrec-db.sql.gz"
# Konto's invoice/estimate PDFs.
docker cp konto:/app/data "$WORK/konto-data" >/dev/null
# Config needed to rebuild from bare metal.
mkdir -p "$WORK/config"
for f in "$HOME/services/docker-compose.yml" "$HOME/services/caddy/Caddyfile" "$HOME/services/.env"; do
  [ -f "$f" ] && cp "$f" "$WORK/config/"
done

# --- tier 1: local tarball + rotation -------------------------------------
ARCHIVE="$BACKUP_DIR/konto-backup-$STAMP.tar.gz"
tar -czf "$ARCHIVE" -C "$WORK" .
ls -1t "$BACKUP_DIR"/konto-backup-*.tar.gz | tail -n +$((KEEP_LOCAL + 1)) | xargs -r rm -f
echo "$(date -Is) local ok: $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1))"

# --- tier 2: offsite via restic (only if configured) ----------------------
if [ -f "$HOME/services/.backup.env" ]; then
  set -a; . "$HOME/services/.backup.env"; set +a
  if command -v restic >/dev/null 2>&1 && [ -n "${RESTIC_REPOSITORY:-}" ]; then
    restic backup --tag konto --host cloud "$WORK" >/dev/null
    restic forget --tag konto --host cloud \
      --keep-daily 14 --keep-weekly 8 --keep-monthly 24 --keep-yearly 10 --prune >/dev/null
    echo "$(date -Is) offsite ok: restic snapshot stored"
  fi
fi
