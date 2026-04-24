#!/usr/bin/env bash
# GSB-100 Restore — rebuild from Backblaze B2 onto a fresh box
# Usage: ./ops/restore.sh                # pulls LATEST backup
#        ./ops/restore.sh 20260501T020000Z   # pulls a specific snapshot
# Requires: b2 CLI authorized, env: BACKBLAZE_BUCKET
set -euo pipefail
cd "$(dirname "$0")/.."

BUCKET="${BACKBLAZE_BUCKET:-gsb-100-backup}"
TARGET_TS="${1:-LATEST}"

if ! command -v b2 >/dev/null; then
  echo "[RESTORE] b2 CLI not installed. Install with: pip install --user b2"; exit 1
fi

echo "[RESTORE] Looking up snapshots in $BUCKET…"
if [ "$TARGET_TS" = "LATEST" ]; then
  ARCHIVE=$(b2 ls "$BUCKET" backups/ | awk '{print $NF}' | grep -E 'gsb-100-[0-9]+T[0-9]+Z\.tar\.gz$' | sort | tail -1)
else
  ARCHIVE="backups/gsb-100-${TARGET_TS}.tar.gz"
fi

if [ -z "${ARCHIVE:-}" ]; then
  echo "[RESTORE] No backup found."; exit 1
fi

echo "[RESTORE] Pulling $ARCHIVE"
TMP="/tmp/gsb-100-restore.tar.gz"
b2 file download "b2://$BUCKET/$ARCHIVE" "$TMP"

STAGE=$(mktemp -d)
tar -xzf "$TMP" -C "$STAGE"
ROOT=$(find "$STAGE" -maxdepth 1 -type d -name "gsb-100-backup-*" | head -1)

# Restore brain DB (backing up any existing to .pre-restore)
mkdir -p data
if [ -f data/brain.db ]; then cp data/brain.db "data/brain.db.pre-restore-$(date -u +%s)"; fi
cp "$ROOT/brain.db" data/brain.db
echo "[RESTORE] brain.db restored"

# Restore logs (merge, don't overwrite current)
mkdir -p logs
cp -n "$ROOT"/logs/* logs/ 2>/dev/null || true

# Restore ops/ (keep existing if same)
cp -r "$ROOT/ops"/* ops/ 2>/dev/null || true

rm -rf "$STAGE" "$TMP"

echo "[RESTORE] Complete. Next steps:"
echo "  1. Copy .env (from Bitwarden) into project root"
echo "  2. npm install"
echo "  3. pm2 start ecosystem.config.js  (or: sudo systemctl enable --now gsb-100-*.service)"
echo "  4. ./ops/health-check.sh  # should print OK"
