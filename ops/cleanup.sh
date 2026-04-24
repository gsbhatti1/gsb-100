#!/usr/bin/env bash
# GSB-100 Cleanup — keep the box lean
# Runs 03:00 daily via cron
set -u
cd "$(dirname "$0")/.."

LOG=logs/cleanup.log
mkdir -p logs
echo "[$(date -u +%FT%TZ)] cleanup starting" >> "$LOG"

# 1. Rotate agent logs > 30 days
find logs -type f -name "*.log" -mtime +30 -delete 2>/dev/null
find logs -type f -name "last-*-run.txt" -mtime +90 -delete 2>/dev/null

# 2. Trim large active logs in place (keep last 10k lines)
for f in logs/*.log; do
  [ -f "$f" ] || continue
  size=$(wc -l < "$f" 2>/dev/null || echo 0)
  if [ "$size" -gt 10000 ]; then
    tail -n 10000 "$f" > "$f.tmp" && mv "$f.tmp" "$f"
    echo "[$(date -u +%FT%TZ)] trimmed $f ($size → 10000 lines)" >> "$LOG"
  fi
done

# 3. Clear playwright cache > 14 days (browsers leave a lot of trash)
if [ -d "$HOME/.cache/ms-playwright" ]; then
  find "$HOME/.cache/ms-playwright" -type f -mtime +14 -delete 2>/dev/null
fi

# 4. npm cache
if command -v npm >/dev/null; then
  npm cache clean --force >/dev/null 2>&1 || true
fi

# 5. Ollama model blob cleanup — remove models not loaded in 60 days
# (conservative: only remove if OLLAMA_CLEANUP=1 set, models are big and re-download is slow)
if [ "${OLLAMA_CLEANUP:-0}" = "1" ] && command -v ollama >/dev/null; then
  ollama list | awk 'NR>1 {print $1}' | while read -r model; do
    # keep the router and embed + reasoning trio always
    case "$model" in
      deepseek-r1:*|nomic-embed-text:*|qwen2.5:*) continue ;;
    esac
    # best-effort prune
    last=$(stat -c %Y "$HOME/.ollama/models/manifests/registry.ollama.ai/library/${model%:*}/${model#*:}" 2>/dev/null || echo 0)
    now=$(date +%s)
    if [ $(( (now - last) / 86400 )) -gt 60 ]; then
      ollama rm "$model" >/dev/null 2>&1 && echo "[$(date -u +%FT%TZ)] removed stale model $model" >> "$LOG"
    fi
  done
fi

# 6. Docker prune (if docker present — Chroma, Langfuse, n8n live here)
if command -v docker >/dev/null; then
  docker system prune -f --filter "until=168h" >/dev/null 2>&1 || true
fi

# 7. Vacuum the brain DB (SQLite reclaim)
DB=${DB_PATH:-./data/brain.db}
if [ -f "$DB" ] && command -v sqlite3 >/dev/null; then
  sqlite3 "$DB" "VACUUM;" 2>/dev/null && echo "[$(date -u +%FT%TZ)] vacuumed $DB" >> "$LOG"
fi

echo "[$(date -u +%FT%TZ)] cleanup done" >> "$LOG"
