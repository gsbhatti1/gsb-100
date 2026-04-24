#!/usr/bin/env bash
# GSB-100 Health Check
# Runs every 15 min via cron. Alerts via alert.js if anything is down.
set -u
cd "$(dirname "$0")/.."

LOG=logs/health.log
mkdir -p logs
timestamp() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
log() { echo "[$(timestamp)] $*" | tee -a "$LOG"; }

FAIL=0
FAIL_REASONS=()

# 1. Ollama running?
if ! curl -sf --max-time 5 "${OLLAMA_HOST:-http://localhost:11434}/api/tags" >/dev/null; then
  FAIL=1; FAIL_REASONS+=("Ollama down")
fi

# 2. Chroma running? (optional — only if CHROMA_HOST set)
if [ -n "${CHROMA_HOST:-}" ]; then
  if ! curl -sf --max-time 5 "${CHROMA_HOST}/api/v2/heartbeat" >/dev/null; then
    FAIL=1; FAIL_REASONS+=("Chroma down")
  fi
fi

# 3. Disk space (alert if <10% free on brain partition)
FREE_PCT=$(df -P "${DB_DIR:-./data}" 2>/dev/null | awk 'NR==2 {gsub("%","",$5); print 100-$5}')
if [ -n "$FREE_PCT" ] && [ "$FREE_PCT" -lt 10 ]; then
  FAIL=1; FAIL_REASONS+=("Disk <10% free ($FREE_PCT%)")
fi

# 4. Agent staleness — last-*-run.txt files should be fresh
#    listing/buyer daily (26h grace), rnd weekly (8d grace)
check_stale() {
  local name=$1 max_hours=$2
  local f="logs/last-${name}-run.txt"
  if [ ! -f "$f" ]; then FAIL=1; FAIL_REASONS+=("$name never ran"); return; fi
  local last_ts=$(date -d "$(cat "$f")" +%s 2>/dev/null || echo 0)
  local now=$(date +%s)
  local age_h=$(( (now - last_ts) / 3600 ))
  if [ "$age_h" -gt "$max_hours" ]; then
    FAIL=1; FAIL_REASONS+=("$name stale (${age_h}h)")
  fi
}
check_stale listing 26
check_stale buyer 26
check_stale rnd 192

# 5. Brain DB exists and >0 bytes
DB=${DB_PATH:-./data/brain.db}
if [ ! -s "$DB" ]; then
  FAIL=1; FAIL_REASONS+=("brain.db missing or empty")
fi

if [ "$FAIL" -eq 0 ]; then
  log "OK"
  exit 0
else
  MSG="GSB-100 HEALTH FAIL: $(IFS=', '; echo "${FAIL_REASONS[*]}")"
  log "$MSG"
  # Fire alert via Node helper — best-effort, don't block
  node -e "require('./notifications/alert').sendAlert(process.argv[1])" "$MSG" 2>>"$LOG" || true
  exit 1
fi
