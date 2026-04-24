#!/usr/bin/env bash
# GSB-100 Setup — one command, fresh Ubuntu 24.04 → running system.
# Run from a fresh clone of github.com/gsbhatti1/gsb-100:
#   sudo ./ops/setup.sh
#
# Idempotent — safe to re-run. Skips what's already there.
set -euo pipefail

if [ "$EUID" -ne 0 ]; then
  echo "Run with sudo: sudo ./ops/setup.sh"; exit 1
fi

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
GSB_USER="${GSB_USER:-gsb}"
INSTALL_DIR="/opt/gsb-100"

log() { echo -e "\n\033[1;34m[SETUP]\033[0m $*"; }

log "1/10  apt deps"
apt-get update -qq
apt-get install -y -qq curl git build-essential sqlite3 jq cron unzip ca-certificates \
  software-properties-common python3-pip ufw

log "2/10  Node 20 LTS"
if ! command -v node >/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi
node -v; npm -v

log "3/10  Docker (Chroma, Langfuse, n8n live here)"
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
  usermod -aG docker "$GSB_USER" 2>/dev/null || true
fi

log "4/10  Ollama + models"
if ! command -v ollama >/dev/null; then
  curl -fsSL https://ollama.com/install.sh | sh
fi
systemctl enable --now ollama
sleep 3
# Pull the model stack — router, reasoning, embeddings
for m in qwen2.5:3b deepseek-r1:32b nomic-embed-text; do
  if ! ollama list | awk '{print $1}' | grep -qx "$m"; then
    log "    pulling $m"
    ollama pull "$m"
  fi
done

log "5/10  Chroma (vector memory)"
docker ps -a --format '{{.Names}}' | grep -qx gsb-chroma || \
  docker run -d --name gsb-chroma --restart unless-stopped \
    -p 8000:8000 -v /opt/gsb-100-data/chroma:/data \
    chromadb/chroma:latest

log "6/10  Langfuse (observability)"
docker ps -a --format '{{.Names}}' | grep -qx gsb-langfuse-db || \
  docker run -d --name gsb-langfuse-db --restart unless-stopped \
    -e POSTGRES_PASSWORD=langfuse -e POSTGRES_DB=langfuse \
    -v /opt/gsb-100-data/langfuse-db:/var/lib/postgresql/data \
    postgres:16-alpine
sleep 4
docker ps -a --format '{{.Names}}' | grep -qx gsb-langfuse || \
  docker run -d --name gsb-langfuse --restart unless-stopped \
    --link gsb-langfuse-db:db \
    -e DATABASE_URL="postgresql://postgres:langfuse@db:5432/langfuse" \
    -e NEXTAUTH_SECRET="$(openssl rand -hex 32)" \
    -e SALT="$(openssl rand -hex 32)" \
    -e NEXTAUTH_URL=http://localhost:3000 \
    -p 3000:3000 \
    langfuse/langfuse:latest

log "7/10  n8n (workflows)"
docker ps -a --format '{{.Names}}' | grep -qx gsb-n8n || \
  docker run -d --name gsb-n8n --restart unless-stopped \
    -p 5678:5678 -v /opt/gsb-100-data/n8n:/home/node/.n8n \
    n8nio/n8n:latest

log "8/10  Install project to $INSTALL_DIR"
id -u "$GSB_USER" >/dev/null 2>&1 || useradd -m -s /bin/bash "$GSB_USER"
mkdir -p "$INSTALL_DIR"
rsync -a --delete --exclude=node_modules --exclude=.git --exclude=data --exclude=logs \
  "$REPO_DIR/" "$INSTALL_DIR/"
mkdir -p "$INSTALL_DIR/data" "$INSTALL_DIR/logs"
chown -R "$GSB_USER":"$GSB_USER" "$INSTALL_DIR"
chmod +x "$INSTALL_DIR/ops/"*.sh 2>/dev/null || true

if [ ! -f "$INSTALL_DIR/.env" ]; then
  cp "$INSTALL_DIR/.env.example" "$INSTALL_DIR/.env"
  log "   .env created from example — EDIT IT: $INSTALL_DIR/.env"
fi

sudo -u "$GSB_USER" bash -c "cd $INSTALL_DIR && npm install --omit=dev"
sudo -u "$GSB_USER" bash -c "cd $INSTALL_DIR && npx playwright install chromium --with-deps" || true

log "9/10  systemd timers"
cp "$INSTALL_DIR/ops/systemd/"*.service /etc/systemd/system/
cp "$INSTALL_DIR/ops/systemd/"*.timer   /etc/systemd/system/
systemctl daemon-reload
for t in listing buyer rnd health backup cleanup; do
  systemctl enable --now "gsb-100-${t}.timer"
done
systemctl list-timers 'gsb-100-*' --no-pager

log "10/10 firewall"
ufw allow 22/tcp >/dev/null
ufw allow from 192.168.0.0/16 to any port 3000 >/dev/null  # Langfuse local-only
ufw allow from 192.168.0.0/16 to any port 5678 >/dev/null  # n8n local-only
ufw allow from 192.168.0.0/16 to any port 8000 >/dev/null  # Chroma local-only
ufw --force enable || true

cat <<EOF

========================================================
  GSB-100 INSTALLED

  Edit:   $INSTALL_DIR/.env   (Gmail app password, Backblaze, Langfuse keys)
  Test:   sudo -u $GSB_USER node $INSTALL_DIR/brain/test-local-ai.js
  Alert:  sudo -u $GSB_USER node $INSTALL_DIR/notifications/alert.js
  Health: $INSTALL_DIR/ops/health-check.sh
  Timers: systemctl list-timers 'gsb-100-*'
  Logs:   tail -f $INSTALL_DIR/logs/*.log

  UIs (local network only):
    Langfuse  http://$(hostname -I | awk '{print $1}'):3000
    n8n       http://$(hostname -I | awk '{print $1}'):5678
    Chroma    http://$(hostname -I | awk '{print $1}'):8000

  Restore from B2:  sudo -u $GSB_USER $INSTALL_DIR/ops/restore.sh
========================================================
EOF
