require("dotenv").config()
const fs = require("fs")
const path = require("path")
const express = require("express")
const cron = require("node-cron")
const {
  getDb,
  addWebsiteLead,
  listWebsiteLeads,
  getWebsiteLead,
  updateWebsiteLead,
  logLeadEvent,
  saveKnowledge,
  logAction,
} = require("../brain/memory-store")
const { signal } = require("../notifications/mission-control")

const PORT = Number(process.env.GSB_REALTOR_AGENT_PORT || 8787)
const WEBHOOK_TOKEN = String(process.env.GSB_LEAD_WEBHOOK_TOKEN || "")
const TIMEZONE = process.env.AGENT_TIMEZONE || "America/Los_Angeles"
const DRAFT_DIR = path.join(process.cwd(), "data", "lead-drafts")
const HOT_THRESHOLD = Number(process.env.GSB_LEAD_HOT_THRESHOLD || 85)
const WARM_THRESHOLD = Number(process.env.GSB_LEAD_WARM_THRESHOLD || 60)
const HOT_FOLLOWUP_MIN = Number(process.env.GSB_HOT_FOLLOWUP_MINUTES || 30)
const WARM_FOLLOWUP_MIN = Number(process.env.GSB_WARM_FOLLOWUP_MINUTES || 180)

function normalize(value) {
  return String(value || "").trim()
}

function digits(value) {
  return normalize(value).replace(/\D+/g, "")
}

function parseBudget(value) {
  const text = normalize(value).toLowerCase()
  if (!text) return null
  const match = text.match(/([\d.,]+)\s*([mbk])?/)
  if (!match) return null
  let amount = Number(match[1].replace(/,/g, ""))
  const suffix = match[2] || ""
  if (suffix === "m") amount *= 1_000_000
  if (suffix === "b") amount *= 1_000_000_000
  if (suffix === "k") amount *= 1_000
  return Number.isFinite(amount) ? amount : null
}

function scoreLead(payload) {
  const haystack = [
    payload.name,
    payload.email,
    payload.phone,
    payload.message,
    payload.timeline,
    payload.propertyType,
    payload.city,
    payload.state,
    payload.source,
  ].join("\n").toLowerCase()

  let score = 15
  if (payload.name) score += 10
  if (payload.email) score += 10
  if (payload.phone) score += 15
  if (payload.message && payload.message.length > 40) score += 10
  if (payload.timeline) score += 10
  if (/call|tour|show|offer|buy|sell|list|invest|1031|nnn|cap rate|strip|retail|industrial|office/.test(haystack)) score += 15
  if (/asap|urgent|today|this week|immediately|right away/.test(haystack)) score += 15
  if (payload.budget) score += 10
  if (payload.propertyType) score += 5
  return Math.min(score, 100)
}

function derivePriority(score) {
  if (score >= HOT_THRESHOLD) return "hot"
  if (score >= WARM_THRESHOLD) return "warm"
  return "cold"
}

function compact(value, max = 280) {
  return normalize(value).replace(/\s+/g, " ").slice(0, max)
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function disclosureHtml() {
  return [
    "Gurpreet Bhatti | REALTOR&reg; | 801-635-8462",
    "UT: Dynasty Point Referral Group | DRE #12907042-SA00",
    "NV: Signature Real Estate | DRE #S.0201351",
    "WY: HomeSmart Realty | DRE #RE-17041",
  ].join("<br>")
}

function buildReplyDraft(lead) {
  const firstName = normalize(lead.name).split(/\s+/)[0] || "there"
  const website = "https://www.gsbrealtor.com"
  const body = [
    `Hi ${firstName},`,
    "",
    "Thank you for reaching out through GSB Realtor.",
    "I reviewed your message and I can help you with the next step.",
    "",
    lead.message ? `What I received: ${compact(lead.message, 240)}` : "",
    "",
    "If you reply with any missing details like timeline, budget, target market, or property type, I can move faster and get you a tighter recommendation.",
    "",
    "Best,",
    "Gurpreet Bhatti",
  ].filter(Boolean).join("\n")

  const html = `<!DOCTYPE html>
<html lang="en">
  <body style="margin:0;padding:0;background:#ffffff;font-family:Arial,Helvetica,sans-serif;color:#102033;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:620px;max-width:620px;border-collapse:collapse;">
      <tr>
        <td align="center" style="padding:16px 0 12px 0;border-bottom:1px solid #dbe3ea;">
          <a href="${website}" style="text-decoration:none;color:#102033;font-size:24px;font-weight:700;letter-spacing:2px;">GSBREALTOR.COM</a>
          <div style="padding-top:6px;font-size:12px;line-height:18px;color:#4e6276;">Commercial Real Estate | NNN Investments | Retail | Industrial | Office</div>
        </td>
      </tr>
      <tr>
        <td style="padding:18px 0 16px 0;font-size:14px;line-height:22px;color:#243748;">
          <div>Hi ${escapeHtml(firstName)},</div>
          <div style="padding-top:12px;">Thank you for reaching out through GSB Realtor.</div>
          <div style="padding-top:12px;">I reviewed your message and I can help you with the next step.</div>
          ${lead.message ? `<div style="padding-top:12px;"><strong>What I received:</strong> ${escapeHtml(compact(lead.message, 240))}</div>` : ""}
          <div style="padding-top:12px;">If you reply with any missing details like timeline, budget, target market, or property type, I can move faster and get you a tighter recommendation.</div>
          <div style="padding-top:16px;">Best,<br>Gurpreet Bhatti</div>
        </td>
      </tr>
      <tr>
        <td style="padding:12px 0;border-top:1px solid #e7edf3;border-bottom:1px solid #e7edf3;text-align:center;">
          <a href="${website}" style="display:inline-block;background:#0e6ba8;color:#ffffff;text-decoration:none;font-size:12px;font-weight:700;line-height:18px;padding:8px 12px;border-radius:4px;margin:0 4px;">Visit Website</a>
          <a href="mailto:gsbhatti1@yahoo.com" style="display:inline-block;background:#102033;color:#ffffff;text-decoration:none;font-size:12px;font-weight:700;line-height:18px;padding:8px 12px;border-radius:4px;margin:0 4px;">Email</a>
          <a href="tel:+18016358462" style="display:inline-block;background:#1a8f5a;color:#ffffff;text-decoration:none;font-size:12px;font-weight:700;line-height:18px;padding:8px 12px;border-radius:4px;margin:0 4px;">Call</a>
        </td>
      </tr>
      <tr>
        <td style="padding:12px 0 0 0;font-size:11px;line-height:17px;color:#5c6f82;">
          <strong style="color:#102033;">Disclosure:</strong><br>${disclosureHtml()}
        </td>
      </tr>
    </table>
  </body>
</html>`

  return { subject: "Thanks for reaching out to GSB Realtor", text: body, html }
}

function writeDraftFiles(leadId, draft) {
  fs.mkdirSync(DRAFT_DIR, { recursive: true })
  const base = path.join(DRAFT_DIR, `lead-${leadId}`)
  fs.writeFileSync(`${base}.txt`, `${draft.subject}\n\n${draft.text}`)
  fs.writeFileSync(`${base}.html`, draft.html)
  return `${base}.html`
}

function followupMinutes(priority) {
  return priority === "hot" ? HOT_FOLLOWUP_MIN : WARM_FOLLOWUP_MIN
}

function shouldAlertFollowup(lead) {
  if (!["new", "contacted"].includes(String(lead.stage || ""))) return false
  const waitMin = followupMinutes(lead.priority)
  const anchor = lead.last_alerted_at || lead.created_at
  if (!anchor) return false
  const since = Date.now() - new Date(anchor).getTime()
  return since >= waitMin * 60 * 1000
}

async function processFollowups() {
  const leads = await listWebsiteLeads(100)
  for (const lead of leads) {
    if (!shouldAlertFollowup(lead)) continue
    const msg = [
      `Lead follow-up due: ${lead.name || "Unknown lead"}`,
      `Priority: ${lead.priority} | Score: ${lead.score}`,
      lead.email ? `Email: ${lead.email}` : "",
      lead.phone ? `Phone: ${lead.phone}` : "",
      lead.message ? `Message: ${compact(lead.message, 180)}` : "",
    ].filter(Boolean).join("\n")
    const result = await signal(lead.priority === "hot" ? "P1" : "P2", "gsb-realtor-agent", msg)
    if (result.delivered) {
      await updateWebsiteLead(lead.id, { lastAlertedAt: new Date().toISOString(), stage: "contacted" })
      await logLeadEvent(lead.id, "followup-alert", { level: lead.priority === "hot" ? "P1" : "P2" })
    }
  }
}

function normalizeLeadPayload(body = {}) {
  const lead = {
    source: normalize(body.source || body.platform || "gsbrealtor.com"),
    name: normalize(body.name || body.fullName),
    email: normalize(body.email),
    phone: digits(body.phone),
    message: compact(body.message || body.notes || body.details || ""),
    propertyType: normalize(body.propertyType || body.assetType),
    timeline: normalize(body.timeline),
    city: normalize(body.city),
    state: normalize(body.state),
    budget: normalize(body.budget || body.priceRange),
    page: normalize(body.page || body.url),
  }
  const criteria = {
    propertyType: lead.propertyType,
    timeline: lead.timeline,
    city: lead.city,
    state: lead.state,
    budgetText: lead.budget,
    budgetValue: parseBudget(lead.budget),
    page: lead.page,
  }
  const score = scoreLead(lead)
  return { ...lead, criteria, score, priority: derivePriority(score) }
}

async function ingestLead(payload) {
  const lead = normalizeLeadPayload(payload)
  const leadId = await addWebsiteLead({
    source: lead.source,
    name: lead.name,
    email: lead.email,
    phone: lead.phone,
    message: lead.message,
    criteria: lead.criteria,
    score: lead.score,
    priority: lead.priority,
    stage: "new",
    lastAlertedAt: new Date().toISOString(),
  })
  const saved = await getWebsiteLead(leadId)
  const draft = buildReplyDraft(saved)
  const replyDraftPath = writeDraftFiles(leadId, draft)
  await updateWebsiteLead(leadId, { replyDraftPath })
  await saveKnowledge(`website-lead-${leadId}`, JSON.stringify({ ...lead, draftSubject: draft.subject }), "gsb-realtor-agent")
  await logLeadEvent(leadId, "ingested", { score: lead.score, priority: lead.priority, source: lead.source })
  await logAction("gsb-realtor-agent", "lead-ingested", `${lead.name || "unknown"} | ${lead.priority} | ${lead.source}`)

  const notice = [
    `New website lead: ${lead.name || "Unknown"}`,
    `Priority: ${lead.priority} | Score: ${lead.score}`,
    lead.email ? `Email: ${lead.email}` : "",
    lead.phone ? `Phone: ${lead.phone}` : "",
    lead.propertyType ? `Type: ${lead.propertyType}` : "",
    lead.timeline ? `Timeline: ${lead.timeline}` : "",
    lead.budget ? `Budget: ${lead.budget}` : "",
    lead.page ? `Page: ${lead.page}` : "",
    lead.message ? `Message: ${lead.message}` : "",
    `Draft: ${replyDraftPath}`,
  ].filter(Boolean).join("\n")

  await signal(lead.priority === "hot" ? "P1" : "P2", "gsb-realtor-agent", notice)
  return { leadId, priority: lead.priority, score: lead.score, replyDraftPath }
}

async function start() {
  await getDb()

  const app = express()
  app.use(express.json({ limit: "1mb" }))

  app.get("/health", async (_req, res) => {
    const leads = await listWebsiteLeads(5)
    res.json({ ok: true, service: "gsb-realtor-agent", leadsTracked: leads.length, port: PORT })
  })

  app.post("/webhooks/gsb-realtor/lead", async (req, res) => {
    const token = String(req.headers["x-gsb-webhook-token"] || req.query.token || req.body.token || "")
    if (WEBHOOK_TOKEN && token !== WEBHOOK_TOKEN) {
      return res.status(401).json({ ok: false, error: "invalid token" })
    }

    try {
      const result = await ingestLead(req.body || {})
      return res.json({ ok: true, ...result })
    } catch (error) {
      console.error("[GSB REALTOR AGENT] Lead ingest failed:", error.message)
      return res.status(500).json({ ok: false, error: error.message })
    }
  })

  app.get("/leads", async (_req, res) => {
    const rows = await listWebsiteLeads(25)
    res.json({
      ok: true,
      leads: rows.map((row) => ({
        id: row.id,
        name: row.name,
        email: row.email,
        phone: row.phone,
        score: row.score,
        priority: row.priority,
        stage: row.stage,
        created_at: row.created_at,
      })),
    })
  })

  app.listen(PORT, () => {
    console.log(`[GSB REALTOR AGENT] Listening on http://localhost:${PORT}`)
  })

  cron.schedule("*/10 * * * *", () => {
    processFollowups().catch((error) => {
      console.error("[GSB REALTOR AGENT] Follow-up run failed:", error.message)
    })
  }, { timezone: TIMEZONE })

  console.log(`[GSB REALTOR AGENT] Follow-up scheduler armed (*/10 * * * *) ${TIMEZONE}`)
}

if (process.env.RUN_ONCE === "1" || process.argv.includes("--run-now")) {
  processFollowups()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error)
      process.exit(1)
    })
} else {
  start().catch((error) => {
    console.error("[GSB REALTOR AGENT] Boot failed:", error)
    process.exit(1)
  })
}
