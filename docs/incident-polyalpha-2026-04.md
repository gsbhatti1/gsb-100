# Incident — PolyAlphaBot dead end (April 2026)

**Reported by:** baldeep
**Symptoms:** "paper money keep going to zero", "hit dead end after somebody fuck with it" — likely an AI tool (referred to as "Comet Perplexity") made uncommitted edits that left the bot unable to run end-to-end.
**Inspected:** `C:\PolyAlphaBot` on 2026-04-24.
**Status:** diagnosed, surgery deferred — this is a separate conversation. Do NOT try to fix it in the mission-control session.

## What I found

### 1. The config is mostly sane
`config.py` looks clean — Kelly fraction, risk caps, filter thresholds, anomaly scoring all look like a maturely-tuned system. No obvious tampering in the parameters themselves.

### 2. `DB_PATH` default is wrong for Windows
```python
DB_PATH = os.getenv("DB_PATH", "/home/polymarket/poly_alpha_bot/poly_alpha.db")
```
That's a Linux VPS path. If the user is running the bot locally on Windows without exporting `DB_PATH`, it will fail to open or create the SQLite file. Result: **no `paper_ledger` rows get written, so bankroll appears "stuck at zero" because there is no ledger, not because positions are losing.**

**Fix:** set `DB_PATH=C:/PolyAlphaBot/poly_alpha.db` in the local `.env`, or pick a Windows-friendly default.

### 3. Upgrade-script zoo — classic AI-assisted rewrite damage
Co-existing in the repo root:
- `build_v2.py`
- `upgrade_v2_engine.py`
- `deploy_upgrade_v3.py`
- `autoload_patch.py`
- `autopatch_ledger.py`
- `scripts/autopatch_execution_hardening.py`
- `v2_engine/main.py` (newer engine, WIP per README)

When multiple "upgrade" + "autopatch" scripts coexist without being deleted, they typically monkey-patch the same hooks and silently stomp on each other. This is almost certainly what "dead end after Comet" means.

**Triage rule for the surgery session:** pick ONE path, delete the rest.
- Option A (safe): revert to HEAD~N before the autopatch work began, re-run only `poly_alpha_monitor.py` (the main loop per README) with a clean config.
- Option B (risky): keep v2_engine/, delete every `autopatch_*` and `upgrade_*` file, verify `poly_alpha_monitor.py` still imports cleanly.

### 4. VPS-oriented deployment model
README documents `systemd` on a VPS, not local Windows. Running it locally is possible but undocumented — the user may be running the wrong mode entirely.

## What the user wants long-term

Per the Apr 2026 conversation — not to babysit PolyAlphaBot internals, just to get **signal** from it:
1. One unified Telegram bot (done — see `notifications/mission-control.js`)
2. Auto-fix for small problems, human-in-loop only for money/API (partially done — see `ops/garbage-collect.js` `autoFix()`)
3. Weekly log with 7-day retention (done — `DAYS.ACTION_LOG = 7`)

## Next session checklist (when user is ready to do the surgery)

1. **Decide: keep or rebuild.** If the bot has been broken for weeks and never had a profitable paper run, a fresh rebuild from the README architecture may beat fixing the autopatch damage.
2. **Add a bridge agent to gsb-100:** `agents/poly-watchdog.js` — pings the poly DB's mtime every hour. If the `paper_ledger` hasn't moved in >4 hours during market hours, fire a `signal("P1", "poly-dead", …)`. That way the bot's health feeds through mission-control just like everything else.
3. **Point the bot's Telegram alerts through mission-control** — either by replacing `alerts.py` send calls with a POST to a local gsb-100 HTTP endpoint, or by having gsb-100 tail its log file. Goal: ONE Telegram bot buzzes the user, not four.
4. **Keep hard-money + paper-money resets and API-key updates as human-only actions.** Never auto-execute those from gsb-100. They are already on the P0 whitelist.

## References

- User conversation 2026-04-23/24 (pre-compaction summary in this session's parent transcript)
- `C:\PolyAlphaBot\README.md` — architecture + roadmap
- `C:\PolyAlphaBot\config.py` — tuned parameters (preserve these)
- `C:\gsb-100\notifications\mission-control.js` — where all alerts should eventually route
