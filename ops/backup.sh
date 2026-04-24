#!/usr/bin/env bash
# GSB-100 Nightly Backup to Backblaze B2
# Runs 02:00 daily via cron. Pushes brain.db, logs, and config snapshot.
# Requires: b2 CLI authorized (b2 account authorize), env: BACKBLAZE_BUCKET
set -euo pipefail
cd "$(dirname "$0")/.."

TS=$(date -u +"%Y%m%dT%H%M%SZ")
STAGE="/tmp/gsb-100-backup-$TS"
ARCHIVE="/tmp/gsb-100-$TS.tar.gz"
BUCKET="${BACKBLAZE_BUCKET:-gsb-100-backup}"
RETAIN_DAYS=90

mkdir -p "$STAGE"

# 1. Snapshot brain DB (use sqlite .backup for consistency, fall back to cp)
DB=${DB_PATH:-./data/brain.db}
if command -v sqlite3 >/dev/null && [ -f "$DB" ]; then
  sqlite3 "$DB" ".backup '$STAGE/brain.db'"
else
  cp "$DB" "$STAGE/brain.db" 2>/dev/null || echo "[WARN] no brain.db to back up"
fi

# 2. Copy logs (last 7 days only)
mkdir -p "$STAGE/logs"
find logs -type f -mtime -7 -exec cp {} "$STAGE/logs/" \; 2>/dev/null || true

# 3. Copy config (but NOT .env — secrets go to Bitwarden, not B2)
cp ecosystem.config.js package.json .env.example "$STAGE/" 2>/dev/null || true
cp -r ops "$STAGE/" 2>/dev/null || true

# 4. Archive
tar -czf "$ARCHIVE" -C /tmp "gsb-100-backup-$TS"

# 5. Upload via b2 CLI (install: pip install b2 or apt install b2)
if command -v b2 >/dev/null; then
  b2 file upload "$BUCKET" "$ARCHIVE" "backups/gsb-100-$TS.tar.gz"
  echo "[BACKUP] Uploaded gsb-100-$TS.tar.gz to $BUCKET"
else
  echo "[BACKUP] b2 CLI not installed — archive kept at $ARCHIVE"
  exit 1
fi

# 6. Prune local stage
rm -rf "$STAGE" "$ARCHIVE"

# 7. Prune remote older than RETAIN_DAYS (best-effort)
CUTOFF=$(date -u -d "$RETAIN_DAYS days ago" +%Y%m%d 2>/dev/null || date -u -v-${RETAIN_DAYS}d +%Y%m%d)
b2 ls "$BUCKET" backups/ 2>/dev/null | awk '{print $NF}' | while read -r f; do
  fname=$(basename "$f")
  fdate=$(echo "$fname" | grep -oE '[0-9]{8}' | head -1)
  if [ -n "$fdate" ] && [ "$fdate" -lt "$CUTOFF" ]; then
    b2 file delete "b2://$BUCKET/$f" >/dev/null 2>&1 || true
    echo "[BACKUP] Pruned $f"
  fi
done

# 8. Alert success
node -e "require('./notifications/alert').sendAlert('GSB-100 backup OK: gsb-100-$TS')" 2>/dev/null || true
echo "[BACKUP] Complete"
