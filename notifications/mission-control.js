// GSB-100 Mission Control — one Telegram pipe, everything else is noise.
//
// The user's rule: "small tweek and small fix my gsb-100 team can take care of
// 99% of the problem till something major happening". So this module acts as a
// doorman for every alert the system wants to send. It drops trash on the floor,
// folds routine info into a weekly digest, and only pings the user's phone when
// a human decision is actually required.
//
// Priority levels — the ONLY reason to buzz the user's phone is P0/P1:
//   P0 CRITICAL  — money event, API key dead, bot down >24h, system can't self-heal
//   P1 ACTIONABLE — HOT realtor lead, signal worth trading, decision queued for you
//   P2 INFO      — agent run summaries, scan deltas, GC results (goes to weekly digest only)
//   P3 TRASH     — heartbeats, "still alive", noisy success lines (dropped)
//
// Weekly digest runs Sunday 09:00 America/Los_Angeles and sends ONE message
// summarizing the week's P2/P3 activity. That's the "one week log" the user wants.
//
// Every alert is recorded into notifications_log so the digest is never lossy
// even if Telegram goes down. Messages are de-duplicated by (source, level, hash)
// within a rolling window to kill flap storms.

require("dotenv").config()
const crypto = require("crypto")
const { sendAlert } = require("./alert")
const { getDb, save } = require("../brain/memory-store")

const TZ = process.env.AGENT_TIMEZONE || "America/Los_Angeles"

// How long to suppress a repeat of the same (source, level, hash) message
const DEDUP_WINDOW_MIN = {
  P0: 30,     // critical — 30 min re-alert window
  P1: 60,     // actionable — 1 hour
  P2: 1440,   // info — 24 hours (digest catches the rest)
  P3: 10080,  // trash — a full week before re-logging
}

// Hard ceiling on P1 alerts per hour so one misbehaving agent can't jam the phone
const P1_HOURLY_CEILING = Number(process.env.MC_P1_CEILING_PER_HOUR || 6)

// Sources that are allowed to escalate to P0 — whitelist, prevents runaway crits
const P0_ALLOWED_SOURCES = new Set([
  "money-reset", "api-expired", "bot-dead", "db-corrupt",
  "gc-crashed", "disk-full", "mission-control",
])

async function ensureTable() {
  const db = await getDb()
  db.run(`
    CREATE TABLE IF NOT EXISTS notifications_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      level TEXT NOT NULL,
      source TEXT NOT NULL,
      message TEXT NOT NULL,
      dedup_key TEXT NOT NULL,
      delivered INTEGER DEFAULT 0,
      suppressed_reason TEXT,
      logged_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_notif_dedup
      ON notifications_log(dedup_key, logged_at);
    CREATE INDEX IF NOT EXISTS idx_notif_level_time
      ON notifications_log(level, logged_at);
  `)
  save()
  return db
}

function hash(s) {
  return crypto.createHash("sha1").update(s).digest("hex").slice(0, 12)
}

function dedupKey(level, source, message) {
  return `${level}:${source}:${hash(message)}`
}

// Has an identical notification fired inside the dedup window?
function recentlyFired(db, key, level) {
  const windowMin = DEDUP_WINDOW_MIN[level] || 60
  const s = db.prepare(
    `SELECT COUNT(*) AS c FROM notifications_log
     WHERE dedup_key = ? AND delivered = 1
     AND logged_at > datetime('now', ?)`
  )
  s.bind([key, `-${windowMin} minutes`])
  let c = 0
  if (s.step()) c = s.getAsObject().c || 0
  s.free()
  return c > 0
}

function p1CountLastHour(db) {
  const s = db.prepare(
    `SELECT COUNT(*) AS c FROM notifications_log
     WHERE level='P1' AND delivered=1
     AND logged_at > datetime('now','-1 hour')`
  )
  let c = 0
  if (s.step()) c = s.getAsObject().c || 0
  s.free()
  return c
}

function record(db, level, source, message, key, delivered, suppressedReason = null) {
  db.run(
    `INSERT INTO notifications_log (level, source, message, dedup_key, delivered, suppressed_reason)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [level, source, message, key, delivered ? 1 : 0, suppressedReason]
  )
  save()
}

// Public API — every part of the system should go through this.
// Usage:
//   const mc = require("../notifications/mission-control")
//   await mc.signal("P1", "realtor-leads", "HOT lead: Jane Doe, score 92, Sandy UT")
//
// Returns: { delivered: boolean, suppressedReason: string|null }
async function signal(level, source, message) {
  const lvl = String(level).toUpperCase()
  if (!["P0", "P1", "P2", "P3"].includes(lvl)) {
    throw new Error(`[MC] invalid level ${level}`)
  }
  if (!source || typeof source !== "string") {
    throw new Error("[MC] source is required (e.g. 'gc', 'realtor-leads')")
  }
  if (!message || typeof message !== "string") return { delivered: false, suppressedReason: "empty" }

  // P0 must be on whitelist — prevents runaway "everything is critical" pages
  if (lvl === "P0" && !P0_ALLOWED_SOURCES.has(source)) {
    console.warn(`[MC] P0 from non-whitelisted source '${source}' — demoted to P1`)
    return signal("P1", source, message)
  }

  const db = await ensureTable()
  const key = dedupKey(lvl, source, message)

  // P3 never goes to phone — digest only, drop from log after window expires (GC handles)
  if (lvl === "P3") {
    record(db, lvl, source, message, key, false, "trash-tier")
    return { delivered: false, suppressedReason: "trash-tier" }
  }

  // P2 never goes to phone immediately — weekly digest will pick it up
  if (lvl === "P2") {
    record(db, lvl, source, message, key, false, "digest-only")
    return { delivered: false, suppressedReason: "digest-only" }
  }

  // P0/P1 — check dedup
  if (recentlyFired(db, key, lvl)) {
    record(db, lvl, source, message, key, false, "dedup-window")
    return { delivered: false, suppressedReason: "dedup-window" }
  }

  // P1 — enforce hourly ceiling
  if (lvl === "P1") {
    const recent = p1CountLastHour(db)
    if (recent >= P1_HOURLY_CEILING) {
      record(db, lvl, source, message, key, false, "hourly-ceiling")
      return { delivered: false, suppressedReason: "hourly-ceiling" }
    }
  }

  // Ship it
  const prefix = lvl === "P0" ? "🚨" : "⚡"
  const body = `${prefix} GSB-100 [${lvl}/${source}]\n${message}`
  try {
    await sendAlert(body)
    record(db, lvl, source, message, key, true)
    return { delivered: true, suppressedReason: null }
  } catch (e) {
    record(db, lvl, source, message, key, false, `alert-error: ${e.message}`)
    return { delivered: false, suppressedReason: `alert-error: ${e.message}` }
  }
}

// Weekly digest — Sunday 09:00 local. Summarizes P2 (info) plus any suppressed P0/P1.
async function buildWeeklyDigest() {
  const db = await ensureTable()

  function group(level) {
    const s = db.prepare(
      `SELECT source, COUNT(*) AS n
       FROM notifications_log
       WHERE level = ? AND logged_at > datetime('now','-7 days')
       GROUP BY source ORDER BY n DESC LIMIT 15`
    )
    s.bind([level])
    const rows = []
    while (s.step()) rows.push(s.getAsObject())
    s.free()
    return rows
  }

  const p0 = group("P0")
  const p1 = group("P1")
  const p2 = group("P2")
  const p3 = group("P3")

  const suppressedS = db.prepare(
    `SELECT suppressed_reason, COUNT(*) AS n
     FROM notifications_log
     WHERE delivered = 0 AND suppressed_reason IS NOT NULL
     AND logged_at > datetime('now','-7 days')
     GROUP BY suppressed_reason ORDER BY n DESC`
  )
  const suppressed = []
  while (suppressedS.step()) suppressed.push(suppressedS.getAsObject())
  suppressedS.free()

  const fmt = rows => rows.length === 0
    ? "  (none)"
    : rows.map(r => `  ${r.source.padEnd(22)} ×${r.n}`).join("\n")

  const fmtSup = suppressed.length === 0
    ? "  (none)"
    : suppressed.map(r => `  ${r.suppressed_reason.padEnd(22)} ×${r.n}`).join("\n")

  return [
    `📊 GSB-100 weekly digest — ${new Date().toISOString().slice(0, 10)}`,
    ``,
    `P0 CRITICAL (pinged phone):`,
    fmt(p0),
    ``,
    `P1 ACTIONABLE (pinged phone):`,
    fmt(p1),
    ``,
    `P2 INFO (routine, digest only):`,
    fmt(p2),
    ``,
    `P3 TRASH (dropped):`,
    fmt(p3),
    ``,
    `Noise filter:`,
    fmtSup,
    ``,
    `Next digest: Sunday 09:00 ${TZ}`,
  ].join("\n")
}

async function sendWeeklyDigest() {
  const body = await buildWeeklyDigest()
  try {
    await sendAlert(body)
    console.log("[MC] weekly digest sent")
  } catch (e) {
    console.error("[MC] digest send failed:", e.message)
  }
}

module.exports = {
  signal,
  buildWeeklyDigest,
  sendWeeklyDigest,
  // exported for test/ad-hoc
  _recentlyFired: recentlyFired,
  _ensureTable: ensureTable,
}

// CLI: node notifications/mission-control.js digest
if (require.main === module) {
  const cmd = process.argv[2]
  if (cmd === "digest") {
    sendWeeklyDigest().then(() => process.exit(0)).catch(e => {
      console.error(e); process.exit(1)
    })
  } else if (cmd === "preview") {
    buildWeeklyDigest().then(d => { console.log(d); process.exit(0) })
  } else if (cmd === "test") {
    // smoke test — won't actually hit Telegram unless env is set
    (async () => {
      console.log(await signal("P0", "mission-control", "boot self-test — you can ignore"))
      console.log(await signal("P1", "mission-control", "boot self-test — you can ignore"))
      console.log(await signal("P2", "mission-control", "info line — digest only"))
      console.log(await signal("P3", "mission-control", "heartbeat — dropped"))
      process.exit(0)
    })()
  } else {
    console.log("usage: node notifications/mission-control.js [digest|preview|test]")
    process.exit(0)
  }
}
