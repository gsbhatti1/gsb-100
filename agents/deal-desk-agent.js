require("dotenv").config()
const fs = require("fs")
const path = require("path")
const axios = require("axios")
const { createScheduledAgent } = require("../brain/agent-runtime")
const { addBuyer, saveKnowledge, logAction } = require("../brain/memory-store")
const { sendTelegram } = require("../notifications/alert")

const STATE_PATH = path.join(process.cwd(), "data", "deal-desk-state.json")
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const ALLOWED_CHAT_ID = String(process.env.DEAL_DESK_ALLOWED_CHAT_ID || process.env.TELEGRAM_CHAT_ID || "")

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"))
  } catch {
    return { offset: 0 }
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true })
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2))
}

function parseBuyerNeeds(text) {
  const lower = String(text || "").toLowerCase()
  const maxPriceMatch = lower.match(/under\s+\$?\s*([\d.,]+)\s*([mbk])?/) || lower.match(/max\s+\$?\s*([\d.,]+)\s*([mbk])?/)
  let maxPrice = null
  if (maxPriceMatch) {
    let value = Number(String(maxPriceMatch[1]).replace(/,/g, ""))
    const suffix = (maxPriceMatch[2] || "").toLowerCase()
    if (suffix === "m") value *= 1_000_000
    if (suffix === "b") value *= 1_000_000_000
    if (suffix === "k") value *= 1_000
    maxPrice = value
  }

  const type =
    lower.includes("nnn") || lower.includes("triple net") ? "nnn" :
    lower.includes("retail") ? "retail" :
    lower.includes("industrial") ? "industrial" :
    lower.includes("office") ? "office" :
    lower.includes("multifamily") ? "multifamily" :
    "commercial"

  const locationMatch = text.match(/\bin\s+([A-Za-z ,]+)$/i)
  const location = locationMatch ? locationMatch[1].trim() : "Utah"

  return {
    raw: text,
    type,
    maxPrice,
    location,
    keywords: Array.from(new Set(String(text).split(/[^A-Za-z0-9#.+-]+/).map((v) => v.trim()).filter((v) => v.length > 2))).slice(0, 12),
  }
}

function parseCommand(text) {
  const trimmed = String(text || "").trim()
  if (!trimmed) return { kind: "empty" }
  if (/^help$/i.test(trimmed)) return { kind: "help" }
  if (/^status$/i.test(trimmed)) return { kind: "status" }

  const parts = trimmed.split("|").map((v) => v.trim())
  if (parts.length >= 3 && /^new buyer$/i.test(parts[0])) {
    return {
      kind: "new-buyer",
      name: parts[1],
      needs: parts.slice(2).join(" | "),
    }
  }

  return { kind: "unknown", raw: trimmed }
}

async function getUpdates(offset) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates`
  const response = await axios.get(url, {
    params: { timeout: 10, offset },
    timeout: 20000,
  })
  return response.data?.result || []
}

async function processUpdate(update) {
  const message = update.message || update.edited_message
  if (!message) return

  const chatId = String(message.chat?.id || "")
  if (!ALLOWED_CHAT_ID || chatId !== ALLOWED_CHAT_ID) {
    if (chatId) await sendTelegram("Deal Desk is locked to the owner chat only.", chatId).catch(() => {})
    return
  }

  const parsed = parseCommand(message.text)

  if (parsed.kind === "help") {
    await sendTelegram(
      "Deal Desk commands:\nnew buyer | John Smith | NNN retail under 5M in Utah\nstatus",
      chatId
    )
    return
  }

  if (parsed.kind === "status") {
    await sendTelegram("Deal Desk is online and listening.", chatId)
    return
  }

  if (parsed.kind === "new-buyer") {
    const criteria = parseBuyerNeeds(parsed.needs)
    await addBuyer(parsed.name, "", "", criteria)
    await saveKnowledge(`deal-desk-buyer-${parsed.name}`, parsed.needs, "deal-desk-agent")
    await logAction("deal-desk-agent", "new-buyer", `${parsed.name} | ${parsed.needs}`)
    await sendTelegram(
      `Buyer added.\nName: ${parsed.name}\nType: ${criteria.type}\nLocation: ${criteria.location}\nMax price: ${criteria.maxPrice || "n/a"}\nNeeds: ${criteria.raw}`,
      chatId
    )
    return
  }

  if (parsed.kind === "unknown") {
    await sendTelegram(
      "Unknown command.\nUse:\nnew buyer | John Smith | NNN retail under 5M in Utah",
      chatId
    )
  }
}

async function run() {
  if (!BOT_TOKEN || !ALLOWED_CHAT_ID) {
    console.log("[DEAL DESK] Telegram not configured")
    return
  }

  const state = loadState()
  const updates = await getUpdates(state.offset || 0)
  let offset = state.offset || 0

  for (const update of updates) {
    offset = Math.max(offset, Number(update.update_id || 0) + 1)
    await processUpdate(update)
  }

  state.offset = offset
  saveState(state)
}

createScheduledAgent({
  name: "DEAL DESK",
  schedule: "* * * * *",
  run,
})
