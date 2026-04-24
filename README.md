# GSB-100

> A 100-year private AI system for GBS Realty, Salt Lake City Utah.
> Runs on your own hardware. Zero API cost. Zero data leaves the building.
> Learns from every deal, every failure, every market signal — and compounds.

---

## What this is

GSB-100 is not one script. It is a **brain**: a persistent, self-improving AI
system that manages listings, hunts for buyers, studies the market, and gets
smarter every day. Built so it can be handed to your kids in 2055 and keep
running on whatever hardware is current then.

**The philosophy:** the system was built to outlast any device — the
knowledge is the asset. Hardware is replaceable. The failure vault, the
market memory, the deal history — that is the inheritance.

---

## Architecture

```
┌─────────────────── GMKtec EVO-X2 (Ubuntu 24.04) ────────────────────┐
│                                                                     │
│   Ollama            qwen2.5:3b   ← fast router, classification      │
│   (localhost:11434) deepseek-r1:32b  ← reasoning, copy, strategy    │
│                     nomic-embed-text ← vector embeddings            │
│                                                                     │
│   Chroma            semantic memory — failures, deals, clients      │
│   (localhost:8000)                                                  │
│                                                                     │
│   Langfuse          trace every agent run, weekly quality review    │
│   (localhost:3000)                                                  │
│                                                                     │
│   n8n               visual workflows, wraps agents                  │
│   (localhost:5678)                                                  │
│                                                                     │
│   Node agents       listing / buyer / R&D — systemd timers          │
│   SQLite brain      /opt/gsb-100/data/brain.db                      │
│                                                                     │
└────────────┬─────────────────────────────────┬──────────────────────┘
             │                                 │
             ▼                                 ▼
   Synology DS (RAID 1)              Backblaze B2 (offsite)
   hourly SMB snapshot                nightly encrypted tar.gz
             │
             ▼
   Raspberry Pi 5 (hot spare)
   same repo, restore in 45 min
```

### The three agents

| Agent | Runs | Purpose |
|---|---|---|
| `listing-agent.js` | daily 07:00 | AI-writes MLS copy for every pending property, flips status pending→active |
| `buyer-agent.js` | daily 06:00 | For each active buyer, generates a platform-specific search strategy. Will scrape LoopNet/Crexi/MLS in phase 2. |
| `rnd-scanner.js` | Fri 08:00 | Scans 8 Utah market topics, asks the 32B for 3 business ideas, stores to `ideas` table |

Plus three ops timers:

| Timer | Runs | Purpose |
|---|---|---|
| `gsb-100-health.timer` | every 15 min | Ollama / Chroma / disk / agent staleness — alerts on failure |
| `gsb-100-backup.timer` | daily 02:00 | SQLite snapshot + logs + config → Backblaze, 90-day retention |
| `gsb-100-cleanup.timer` | daily 03:00 | Rotate logs, prune Docker, VACUUM brain.db |

### The five memory layers (like a human brain)

1. **Structured facts** — SQLite tables (properties, buyers, ideas, action_log)
2. **Semantic memory** — Chroma vector store over failures, deals, market observations
3. **Failure vault** — every failure recorded with `whatHappened`, `rootCause`, `neverDo`. Agents check before repeating a pattern.
4. **Knowledge base** — weekly R&D topic scans, curated market intelligence
5. **Observability trace** — Langfuse stores every agent run for weekly drift review

---

## Setup (fresh Ubuntu 24.04 on the GMKtec)

```bash
git clone https://github.com/gsbhatti1/gsb-100.git
cd gsb-100
sudo ./ops/setup.sh
```

`setup.sh` is idempotent. It installs Node 20, Docker, Ollama, pulls the
three models, starts Chroma + Langfuse + n8n as containers, copies the
project to `/opt/gsb-100`, registers every systemd timer, and configures
ufw so the UIs are local-network-only.

Then edit `/opt/gsb-100/.env` with your real Gmail app password, Backblaze
keys, and Langfuse keys (the Langfuse UI at `http://<host>:3000` gives you
the keys on first login).

### Test in order

```bash
sudo -u gsb node /opt/gsb-100/brain/test-local-ai.js       # DeepSeek responds
sudo -u gsb node /opt/gsb-100/notifications/alert.js        # phone rings
sudo -u gsb node /opt/gsb-100/brain/vector-memory.js        # Chroma round-trip
sudo -u gsb node /opt/gsb-100/brain/ai-router.js            # multi-model routing
sudo /opt/gsb-100/ops/health-check.sh                       # prints OK
```

---

## Dev on Windows (before deploying to the GMKtec)

The repo was built on Windows first. Everything in `agents/`, `brain/`,
and `notifications/` is cross-platform. Only `ops/*.sh` and `ops/systemd/*`
are Linux-only.

```powershell
cd C:\gsb-100
npm install
node brain\test-local-ai.js
npm run chat          # interactive REPL with the 32B
pm2 start ecosystem.config.js
```

PM2 handles scheduling on Windows; systemd handles it on Linux. Same
agent code either way.

---

## When a device dies

Everything you need to rebuild is in two places: **GitHub** (code) and
**Backblaze B2** (data). Bitwarden holds the credentials.

```bash
# On a fresh box:
git clone https://github.com/gsbhatti1/gsb-100.git
cd gsb-100
sudo ./ops/setup.sh
# Pull the latest brain snapshot:
sudo -u gsb /opt/gsb-100/ops/restore.sh
# Paste .env from Bitwarden into /opt/gsb-100/.env
sudo systemctl restart 'gsb-100-*.timer'
```

Target: 45 minutes from bare metal to fully running.

---

## Hardware

| Role | Device | Status |
|---|---|---|
| Primary brain | GMKtec EVO-X2 (AMD Ryzen AI Max+ 395, 64GB unified, 2TB SSD) | in-hand |
| Hot spare | Raspberry Pi 5 8GB + Argon NEO 5 M.2 + Crucial P310 2TB | in-hand |
| Power protection | APC Back-UPS 650VA | arriving 2026-04-15 |
| UPS HAT | GeeekPi UPS Gen 6 | in-hand |
| Local cold storage | Synology DS223j + 2× Seagate IronWolf Pro 8TB (RAID 1) | arriving 2026-04-23 |
| Offsite backup | Backblaze B2 (`gsb-100-backup` bucket) | ~$1/mo |
| Secrets | Bitwarden (free family plan) | — |

Future upgrade paths already supported by the code: swap DS223j for DS725+
(more RAM, Docker), add second GMKtec for HA pair, LoRA-fine-tune a 7B on
your own Utah transaction data once you have 6 months of deals.

---

## Cron schedule summary

```
06:00 daily   buyer-agent
07:00 daily   listing-agent
08:00 Fri     rnd-scanner
02:00 daily   backup
03:00 daily   cleanup
every 15 min  health-check
```

---

## Security

- `.env` is in `.gitignore` and must never be committed.
- **Credentials that were exposed in early `.env.example` commits are rotated** —
  Gmail app password, Backblaze keys, WhatsApp key. Check git history if
  unsure and rotate again.
- Firewall opens 3000/5678/8000 only to the local LAN. SSH on 22.
- Secrets of record live in Bitwarden, not in this repo.

---

## Files

```
gsb-100/
├── agents/
│   ├── listing-agent.js       # daily MLS copy generator
│   ├── buyer-agent.js         # daily buyer strategy
│   └── rnd-scanner.js         # weekly R&D ideas
├── brain/
│   ├── memory-store.js        # SQLite — properties, buyers, ideas, action_log
│   ├── failure-vault.js       # never-do memory
│   ├── vector-memory.js       # Chroma semantic recall
│   ├── ai-router.js           # multi-model router (fast/reason/embed)
│   ├── observe.js             # Langfuse tracing
│   └── test-local-ai.js       # sanity-check the stack
├── browser/
│   └── playwright-config.js   # human-delay patterns
├── notifications/
│   └── alert.js               # Gmail → T-Mobile gateway → your phone
├── ops/
│   ├── setup.sh               # fresh-box bootstrap
│   ├── health-check.sh        # every 15 min
│   ├── backup.sh              # nightly B2 push
│   ├── restore.sh             # pull latest or specific snapshot
│   ├── cleanup.sh             # nightly trim
│   └── systemd/               # .service + .timer units
├── local-ai-chat.js           # interactive REPL with the 32B
├── ecosystem.config.js        # PM2 (Windows dev)
├── package.json
├── .env.example
└── README.md
```

---

The hardware gets replaced. The knowledge lives forever.
