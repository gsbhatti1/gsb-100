// GSB-100 Garbage Collector
// Philosophy: this is a 100-year system. The asset is deal history, client
// records, the failure vault. That stays forever. Ephemeral operational data
// — scan markers, trace logs, stale match candidates, old log files — gets
// pruned on a schedule so the brain stays lean and RAM stays free.
//
// Runs daily at 03:00 via PM2 (see ecosystem.config.js).
// Manual run:  node ops/garbage-collect.js   (or: npm run gc)
//
// NEVER TOUCHES: properties, buyers, failure_vault, Chroma failures/deals/clients.
// PRUNES:        knowledge, action_log, buyer_matches (by age), log files (by size/age).
// TAGS-STALE:    ideas that went unreviewed past the threshold (not deleted — archived).
require("dotenv").config()
const fs = require("fs")
const path = require("path")
const { getDb, save } = require("../brain/memory-store")
const { signal } = require("../notifications/mission-control")
const { createScheduledAgent } = require("../brain/agent-runtime")

// Retention policy — per user's Apr 2026 ask: "one week log is enough for me
// and all trash could be deleted and fresh stuff should be placed". Anything
// the human would actually re-read (ideas, failure_vault, properties, buyers)
// lives forever. Everything operational rolls off in 7 days.
const DAYS = {
  KNOWLEDGE: Number(process.env.GC_KNOWLEDGE_DAYS || 30),      // was 60
  ACTION_LOG: Number(process.env.GC_ACTION_LOG_DAYS || 7),     // was 60 — weekly window
  BUYER_MATCHES: Number(process.env.GC_BUYER_MATCHES_DAYS || 14), // was 30
  IDEA_STALE: Number(process.env.GC_IDEA_STALE_DAYS || 90),
  LOG_ARCHIVE: Number(process.env.GC_LOG_ARCHIVE_DAYS || 14),  // was 60
  NOTIFICATIONS: Number(process.env.GC_NOTIFICATIONS_DAYS || 30), // keep digest material 30d
}
const LOG_TAIL_LINES = Number(process.env.GC_LOG_TAIL_LINES || 10000)
const LOG_MAX_TRIM_BYTES = 50 * 1024 * 1024 // don't slurp > 50MB into memory

const DB_PATH = process.env.DB_PATH || "C:/gsb-100/data/brain.db"
const LOGS_DIR = path.join(__dirname, "..", "logs")

function fileSize(p) { try { return fs.statSync(p).size } catch { return 0 } }
function fmtKB(bytes) { return (bytes / 1024).toFixed(1) + " KB" }

function countRows(db, table, whereSql, params = []) {
  const s = db.prepare(`SELECT COUNT(*) AS c FROM ${table} ${whereSql}`)
  s.bind(params)
  let c = 0
  if (s.step()) c = s.getAsObject().c || 0
  s.free()
  return c
}

function prune(db, table, whereSql, params = []) {
  const before = countRows(db, table, whereSql, params)
  if (before > 0) db.run(`DELETE FROM ${table} ${whereSql}`, params)
  return before
}

function flipStatus(db, table, setSql, whereSql, params = []) {
  const before = countRows(db, table, whereSql, params)
  if (before > 0) db.run(`UPDATE ${table} SET ${setSql} ${whereSql}`, params)
  return before
}

function rotateLogs() {
  if (!fs.existsSync(LOGS_DIR)) return { trimmed: 0, deleted: 0, bytesFreed: 0 }
  let trimmed = 0, deleted = 0, bytesFreed = 0
  const archiveCutoff = Date.now() - DAYS.LOG_ARCHIVE * 86400000

  for (const name of fs.readdirSync(LOGS_DIR)) {
    const full = path.join(LOGS_DIR, name)
    let stat
    try { stat = fs.statSync(full) } catch { continue }
    if (!stat.isFile()) continue

    // Delete old rotated logs (PM2 uses .log.1, .log.2, ... or date-suffixed names)
    const isRotated = /\.log(\.\d+|-\d{4}-\d{2}-\d{2})$/.test(name)
    if (isRotated && stat.mtimeMs < archiveCutoff) {
      bytesFreed += stat.size
      try { fs.unlinkSync(full); deleted++ } catch (e) { console.warn("[GC]", name, e.message) }
      continue
    }

    // Trim active *.log files to last N lines
    if (name.endsWith(".log") && stat.size <= LOG_MAX_TRIM_BYTES) {
      try {
        const content = fs.readFileSync(full, "utf8")
        const lines = content.split("\n")
        if (lines.length > LOG_TAIL_LINES) {
          const kept = lines.slice(-LOG_TAIL_LINES).join("\n")
          fs.writeFileSync(full, kept)
          bytesFreed += stat.size - Buffer.byteLength(kept, "utf8")
          trimmed++
        }
      } catch (e) {
        // Windows often locks active log files — skip silently
      }
    }
  }
  return { trimmed, deleted, bytesFreed }
}

async function run() {
  const started = Date.now()
  console.log("[GC] Starting —", new Date().toISOString())

  const db = await getDb()
  const sizeBefore = fileSize(DB_PATH)

  // --- SQL prunes ---
  const knowledgeRemoved = prune(
    db, "knowledge",
    `WHERE created_at < datetime('now', ?)`, [`-${DAYS.KNOWLEDGE} days`]
  )
  const actionsRemoved = prune(
    db, "action_log",
    `WHERE logged_at < datetime('now', ?)`, [`-${DAYS.ACTION_LOG} days`]
  )
  const matchesRemoved = prune(
    db, "buyer_matches",
    `WHERE found_at < datetime('now', ?)`, [`-${DAYS.BUYER_MATCHES} days`]
  )
  const ideasStaled = flipStatus(
    db, "ideas", `status='stale'`,
    `WHERE status='new' AND created_at < datetime('now', ?)`, [`-${DAYS.IDEA_STALE} days`]
  )

  // notifications_log — prune the weekly-digest table itself so it stays bounded
  let notificationsRemoved = 0
  try {
    notificationsRemoved = prune(
      db, "notifications_log",
      `WHERE logged_at < datetime('now', ?)`, [`-${DAYS.NOTIFICATIONS} days`]
    )
  } catch (e) {
    // table may not exist on first run before mission-control has booted
    notificationsRemoved = 0
  }

  // --- Auto-fix pass: small things the system can heal without asking ---
  // Rule (user, Apr 2026): "small tweek and fix broken link for better quality
  // they don't need permission". We fix cleanly recoverable state silently.
  const autoFixes = autoFix(db)

  // --- VACUUM to reclaim disk ---
  save()
  try { db.run("VACUUM") } catch (e) { console.warn("[GC] VACUUM failed (non-fatal):", e.message) }
  save()

  const sizeAfter = fileSize(DB_PATH)
  const dbReclaimed = Math.max(0, sizeBefore - sizeAfter)

  // --- Log rotation ---
  const logs = rotateLogs()

  // --- Report ---
  const dur = Math.round((Date.now() - started) / 1000)
  const msg =
    `GSB-100 GC: rows -${knowledgeRemoved}K -${actionsRemoved}A -${matchesRemoved}M -${notificationsRemoved}N | ${ideasStaled} ideas→stale | ` +
    `auto-fix ${autoFixes.total} (${autoFixes.details}) | ` +
    `logs ${logs.trimmed} trimmed, ${logs.deleted} archived deleted | ` +
    `db ${fmtKB(sizeBefore)}→${fmtKB(sizeAfter)} (reclaimed ${fmtKB(dbReclaimed + logs.bytesFreed)}) | ${dur}s`

  console.log("[GC]", msg)

  fs.mkdirSync(LOGS_DIR, { recursive: true })
  fs.writeFileSync(path.join(LOGS_DIR, "last-gc-run.txt"), new Date().toISOString() + "\n" + msg + "\n")

  // GC is routine. It goes to the weekly digest only — no phone ping.
  // The sendAlert → P0 path is reserved for GC *crash*, not GC success.
  await signal("P2", "gc", msg).catch(() => {})
}

// --- Auto-fix pass ---
// Whitelisted small things the GC is allowed to repair on its own. Each one
// returns a count so we can report what was done.
function autoFix(db) {
  const fixes = []
  let total = 0

  // 1) Orphaned buyer_matches where buyer was deleted — clean up dangling rows
  try {
    const before = countRows(
      db, "buyer_matches",
      `WHERE buyer_id NOT IN (SELECT id FROM buyers)`
    )
    if (before > 0) {
      db.run(`DELETE FROM buyer_matches WHERE buyer_id NOT IN (SELECT id FROM buyers)`)
      fixes.push(`orphaned-matches=${before}`); total += before
    }
  } catch {}

  // 2) action_log rows with no agent name — these are corrupt from old bug
  try {
    const before = countRows(db, "action_log", `WHERE agent IS NULL OR agent = ''`)
    if (before > 0) {
      db.run(`DELETE FROM action_log WHERE agent IS NULL OR agent = ''`)
      fixes.push(`corrupt-actions=${before}`); total += before
    }
  } catch {}

  // 3) duplicate ideas (same title) — keep oldest, drop rest
  try {
    const before = countRows(
      db, "ideas",
      `WHERE id NOT IN (SELECT MIN(id) FROM ideas GROUP BY title)`
    )
    if (before > 0) {
      db.run(`DELETE FROM ideas WHERE id NOT IN (SELECT MIN(id) FROM ideas GROUP BY title)`)
      fixes.push(`dupe-ideas=${before}`); total += before
    }
  } catch {}

  // 4) orphaned notifications — trash tier older than 7 days even if the retention window is wider
  try {
    const before = countRows(
      db, "notifications_log",
      `WHERE level='P3' AND logged_at < datetime('now','-7 days')`
    )
    if (before > 0) {
      db.run(`DELETE FROM notifications_log WHERE level='P3' AND logged_at < datetime('now','-7 days')`)
      fixes.push(`trash-notif=${before}`); total += before
    }
  } catch {}

  save()
  return { total, details: fixes.length ? fixes.join(",") : "nothing-to-fix" }
}

async function runWithCrashHandling() {
  try {
    await run()
  } catch (error) {
    console.error("[GC] crashed:", error.message)
    // GC crash IS a P0 — whitelisted in mission-control
    await signal("P0", "gc-crashed", `GC crashed: ${error.message}`).catch(() => {})
    throw error
  }
}

createScheduledAgent({
  name: "GC",
  schedule: "0 3 * * *",
  run: runWithCrashHandling,
})
