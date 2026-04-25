require("dotenv").config()
const fs = require("fs")
const path = require("path")
const { chromium } = require("playwright")
const { createScheduledAgent } = require("../brain/agent-runtime")
const { getActiveBuyers, getBuyerMatchByUrl, saveBuyerMatch, markBuyerMatchSent, saveKnowledge } = require("../brain/memory-store")
const { signal } = require("../notifications/mission-control")
const math = require("../browser/deal-math")

const PROFILE_DIR = process.env.BROWSER_PROFILE_DIR || path.join(process.cwd(), "data", "browser-profile")
const MORTGAGE_RATE = Number(process.env.CURRENT_MORTGAGE_RATE || 6.75)
const SEARCH_URLS_CREXI = (process.env.SEARCH_URLS_CREXI || "").split(",").map((v) => v.trim()).filter(Boolean)
const SEARCH_URLS_LOOPNET = (process.env.SEARCH_URLS_LOOPNET || "").split(",").map((v) => v.trim()).filter(Boolean)
const NNN_TERMS = ["nnn", "net lease", "triple net", "absolute net", "single tenant"]

async function launchPersistentBrowser() {
  fs.mkdirSync(PROFILE_DIR, { recursive: true })
  return chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    channel: "chrome",
    args: ["--disable-blink-features=AutomationControlled"],
    viewport: { width: 1440, height: 960 },
  })
}

function normalizeUrl(base, href) {
  try {
    return new URL(href, base).toString()
  } catch {
    return null
  }
}

function scoreDeal(text, buyerCriteria = {}) {
  const lower = String(text || "").toLowerCase()
  let score = 0
  if (NNN_TERMS.some((term) => lower.includes(term))) score += 45
  if (lower.includes("retail")) score += 10
  if (lower.includes("single tenant")) score += 10
  if (buyerCriteria.type && lower.includes(String(buyerCriteria.type).toLowerCase())) score += 15
  if (buyerCriteria.keywords && Array.isArray(buyerCriteria.keywords)) {
    for (const keyword of buyerCriteria.keywords) {
      if (lower.includes(String(keyword).toLowerCase())) score += 8
    }
  }
  return Math.min(score, 100)
}

function extractFinancials(text) {
  const priceMatch = String(text).match(/(?:price|purchase price)[^\d$]*\$?\s*([\d.,]+(?:\.\d+)?)\s*([mbk])?/i) || String(text).match(/\$\s*([\d.,]+(?:\.\d+)?)\s*([mbk])/i)
  const noiMatch = String(text).match(/\bnoi\b[^\d$]*\$?\s*([\d.,]+(?:\.\d+)?)\s*([mbk])?/i)
  const capMatch = String(text).match(/\bcap(?:\s*rate)?\b[^\d%]*([\d.]+)\s*%/i)
  const titleLine = String(text || "").split("\n").map((v) => v.trim()).filter(Boolean)[0] || "NNN Opportunity"
  const addressLine = String(text || "").split("\n").map((v) => v.trim()).find((line) => /\d+/.test(line)) || titleLine
  const price = priceMatch ? math.parseMoney(`$${priceMatch[1]}${priceMatch[2] || ""}`) : null
  const noi = noiMatch ? math.parseMoney(`$${noiMatch[1]}${noiMatch[2] || ""}`) : null
  const cap = capMatch ? Number(capMatch[1]) : math.capRate(noi, price)
  return { title: titleLine, address: addressLine, price, noi, cap }
}

function buildScenarioLines(price, noi) {
  const lines = []
  for (const downPct of [20, 25]) {
    for (const years of [10, 20, 30]) {
      const deal = math.cashOnCash(noi, price, MORTGAGE_RATE, years, downPct)
      if (!deal) continue
      lines.push(
        `${downPct}% down / ${years}y @ ${math.fmtPct(MORTGAGE_RATE)} -> debt ${math.fmtMoney(deal.annualDebtService)} | cash flow ${math.fmtMoney(deal.annualCashFlow)} | ROI ${math.fmtPct(deal.roiPct)}`
      )
    }
  }
  return lines
}

function buildClientMessage(match) {
  const summary = [
    `${match.platform.toUpperCase()} NNN match: ${match.title}`,
    `Price: ${math.fmtMoney(match.price)} | NOI: ${math.fmtMoney(match.noi)} | Cap: ${math.fmtPct(match.cap)}`,
    `Current mortgage rate used: ${math.fmtPct(MORTGAGE_RATE)}`,
    ...buildScenarioLines(match.price, match.noi),
    `Why it fits: ${match.pitch}`,
    `Link: ${match.url}`,
  ]
  return summary.join("\n")
}

async function scrapeSearch(page, platform, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 })
  await page.waitForTimeout(4000)

  const cards = await page.evaluate(({ platform }) => {
    const anchors = Array.from(document.querySelectorAll("a[href]"))
    const seen = new Set()
    const rows = []

    function closestCard(node) {
      let current = node
      for (let i = 0; i < 6 && current; i += 1) {
        if (["ARTICLE", "LI", "SECTION"].includes(current.tagName)) return current
        if (current.className && /card|listing|result|property/i.test(String(current.className))) return current
        current = current.parentElement
      }
      return node.parentElement
    }

    for (const anchor of anchors) {
      const href = anchor.getAttribute("href") || ""
      if (!href) continue
      if (!/property|listing|sale|lease/i.test(href)) continue
      const absolute = new URL(href, location.href).toString()
      if (seen.has(absolute)) continue
      seen.add(absolute)
      const card = closestCard(anchor)
      const text = (card?.innerText || anchor.innerText || "").replace(/\s+/g, " ").trim()
      if (!text || text.length < 30) continue
      const img = card?.querySelector("img")?.src || null
      rows.push({ platform, url: absolute, text, img })
      if (rows.length >= 20) break
    }
    return rows
  }, { platform })

  return cards
}

async function run() {
  console.log("\n[NNN SCOUT] Starting -", new Date().toISOString())
  const buyers = await getActiveBuyers()
  const context = await launchPersistentBrowser()
  const page = await context.newPage()
  const runNow =
    process.argv.includes("--run-now") ||
    process.env.RUN_ONCE === "1" ||
    process.env.RUN_NOW === "1"

  try {
    const searches = [
      ...SEARCH_URLS_CREXI.map((url) => ({ platform: "crexi", url })),
      ...SEARCH_URLS_LOOPNET.map((url) => ({ platform: "loopnet", url })),
    ]

    if (!searches.length) {
      console.log("[NNN SCOUT] No search URLs configured yet")
      if (runNow) {
        await page.goto("https://www.crexi.com", { waitUntil: "domcontentloaded", timeout: 120000 })
        const loopnetPage = await context.newPage()
        await loopnetPage.goto("https://www.loopnet.com", { waitUntil: "domcontentloaded", timeout: 120000 })
        console.log("[NNN SCOUT] Login mode open - sign into Crexi and LoopNet, then close the browser when done.")
        await new Promise((resolve) => context.once("close", resolve))
      }
      return
    }

    for (const search of searches) {
      const rawCards = await scrapeSearch(page, search.platform, search.url)
      for (const raw of rawCards) {
        const extracted = extractFinancials(raw.text)
        const lower = String(raw.text || "").toLowerCase()
        if (!NNN_TERMS.some((term) => lower.includes(term))) continue

        for (const buyer of buyers) {
          const criteria = JSON.parse(buyer.criteria_json || "{}")
          const exists = await getBuyerMatchByUrl(buyer.id, raw.url)
          if (exists) continue

          const score = scoreDeal(raw.text, criteria)
          if (score < 55) continue

          const pitch = "Strong NNN profile with fast-underwrite numbers ready for client review."
          const match = {
            ...extracted,
            url: raw.url,
            platform: search.platform,
            image: raw.img,
            score,
            pitch,
            sourceText: raw.text,
          }

          const id = await saveBuyerMatch(buyer.id, raw.url, search.platform, score, match)
          const message = buildClientMessage(match)
          await saveKnowledge(`nnn-match-${buyer.id}-${id}`, message, "nnn-scout-agent")
          const notice = `${message}\nBuyer: ${buyer.name}`
          const result = await signal("P1", "nnn-scout", notice)
          if (result.delivered && id) await markBuyerMatchSent(id)
        }
      }
    }
  } finally {
    await page.close().catch(() => {})
    await context.close().catch(() => {})
  }
}

createScheduledAgent({
  name: "NNN SCOUT",
  schedule: "*/30 * * * *",
  run,
})
