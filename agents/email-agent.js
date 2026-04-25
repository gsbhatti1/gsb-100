require("dotenv").config()
const fs = require("fs")
const path = require("path")
const { ImapFlow } = require("imapflow")
const { simpleParser } = require("mailparser")
const { createScheduledAgent } = require("../brain/agent-runtime")
const { getDb, logAction, saveKnowledge } = require("../brain/memory-store")
const { signal } = require("../notifications/mission-control")

const STATE_PATH = path.join(process.cwd(), "data", "email-triage-state.json")
const FIRST_RUN_BACKFILL = 25
const IMPORTANT_TERMS = [
  "client", "lender", "title", "escrow", "attorney", "brokerage", "offer", "lease",
  "contract", "showing", "inspection", "appraisal", "crexi", "loopnet", "costar",
  "mls", "lead", "signed", "urgent", "buyer", "seller", "closing", "listing",
]
const ALERT_NOW_TERMS = [
  "offer", "signed contract", "new lead", "lender", "title", "escrow", "legal",
  "urgent client", "closing", "wire", "earnest money", "counter offer",
]
const JUNK_TERMS = [
  "promo", "promotion", "coupon", "deal", "sale", "discount", "newsletter", "unsubscribe",
  "social", "notification", "recruiting", "job", "political", "fundraising", "advertisement",
  "sponsored", "marketing", "webinar", "random ai", "tool roundup",
]
const NEVER_DELETE_TERMS = [
  "lead", "client", "contract", "title", "escrow", "lender", "legal", "brokerage",
  "mls", "crexi", "loopnet", "costar", "offer", "lease", "showing", "inspection",
]

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"))
  } catch {
    return {}
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true })
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2))
}

function normalize(text) {
  return String(text || "").toLowerCase()
}

function includesAny(text, terms) {
  const value = normalize(text)
  return terms.some((term) => value.includes(term))
}

function classifyMessage({ from, subject, text }) {
  const haystack = `${from}\n${subject}\n${text}`
  const important = includesAny(haystack, IMPORTANT_TERMS)
  const alertNow = includesAny(haystack, ALERT_NOW_TERMS)
  const neverDelete = includesAny(haystack, NEVER_DELETE_TERMS)
  const junk = !neverDelete && includesAny(haystack, JUNK_TERMS)

  if (alertNow) return "alert"
  if (important) return "important"
  if (junk) return "trash"
  return "keep"
}

function compactText(value, max = 220) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max)
}

async function resolveTrashMailbox(client) {
  const boxes = await client.list()
  return (
    boxes.find((box) => box.specialUse === "\\Trash")?.path ||
    boxes.find((box) => /trash/i.test(box.path))?.path ||
    null
  )
}

async function processAccount(account, state) {
  const client = new ImapFlow({ ...account.imap, logger: false })
  const stateKey = account.name
  const lastUid = Number(state[stateKey]?.lastUid || 0)
  let highestUid = lastUid
  let summary = { scanned: 0, important: 0, alerts: 0, trashed: 0, kept: 0 }

  await client.connect()
  try {
    const mailbox = await client.mailboxOpen("INBOX")
    const trashMailbox = await resolveTrashMailbox(client)
    const firstUid = Math.max(1, Number(mailbox.uidNext || 1) - FIRST_RUN_BACKFILL)
    const range = lastUid > 0 ? `${lastUid + 1}:*` : `${firstUid}:*`

    for await (const message of client.fetch(range, { uid: true, envelope: true, source: true })) {
      highestUid = Math.max(highestUid, Number(message.uid || 0))
      summary.scanned += 1

      const parsed = await simpleParser(message.source)
      const from = compactText(parsed.from?.text || message.envelope?.from?.map((p) => p.address || p.name).join(", "))
      const subject = compactText(parsed.subject || message.envelope?.subject || "(no subject)", 180)
      const text = compactText(parsed.text || parsed.html || "", 300)
      const verdict = classifyMessage({ from, subject, text })

      const memo = `[${account.name}] ${subject} | ${from} | ${text}`
      await saveKnowledge(`email-${account.name}-${message.uid}`, memo, "email-agent")

      if (verdict === "trash") {
        summary.trashed += 1
        if (trashMailbox) {
          await client.messageMove(message.uid, trashMailbox)
        }
        await logAction("email-agent", `trash:${account.name}`, subject)
        continue
      }

      if (verdict === "alert" || verdict === "important") {
        if (verdict === "alert") summary.alerts += 1
        else summary.important += 1

        const level = verdict === "alert" ? "P1" : "P2"
        await signal(
          level,
          "email-agent",
          `${account.name}: ${subject}\nFrom: ${from}\n${text}`
        )
        await logAction("email-agent", `${verdict}:${account.name}`, subject)
        continue
      }

      summary.kept += 1
    }
  } finally {
    state[stateKey] = { lastUid: highestUid, checkedAt: new Date().toISOString() }
    saveState(state)
    await client.logout().catch(() => {})
  }

  return summary
}

async function run() {
  console.log("\n[EMAIL AGENT] Starting -", new Date().toISOString())
  await getDb()

  const accounts = [
    {
      name: "gmail",
      imap: {
        host: "imap.gmail.com",
        port: 993,
        secure: true,
        auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
      },
    },
    {
      name: "yahoo",
      imap: {
        host: "imap.mail.yahoo.com",
        port: 993,
        secure: true,
        auth: { user: process.env.YAHOO_USER, pass: process.env.YAHOO_APP_PASSWORD },
      },
    },
  ].filter((account) => account.imap.auth.user && account.imap.auth.pass)

  const state = loadState()
  let total = { scanned: 0, important: 0, alerts: 0, trashed: 0, kept: 0 }

  for (const account of accounts) {
    const summary = await processAccount(account, state)
    total = {
      scanned: total.scanned + summary.scanned,
      important: total.important + summary.important,
      alerts: total.alerts + summary.alerts,
      trashed: total.trashed + summary.trashed,
      kept: total.kept + summary.kept,
    }
    console.log(`[EMAIL AGENT] ${account.name}:`, summary)
  }

  await signal(
    "P2",
    "email-agent",
    `Email triage done. Scanned ${total.scanned}, alerts ${total.alerts}, important ${total.important}, trashed ${total.trashed}, kept ${total.kept}.`
  )
}

createScheduledAgent({
  name: "EMAIL AGENT",
  schedule: "*/15 * * * *",
  run,
})
