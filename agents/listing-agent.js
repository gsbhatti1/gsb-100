require("dotenv").config()
const fs = require("fs")
const { getDb, saveKnowledge, save } = require("../brain/memory-store")
const { checkBeforeActing, recordFailure } = require("../brain/failure-vault")
const { sendAlert } = require("../notifications/alert")
const { humanDelay } = require("../browser/playwright-config")
const ai = require("../brain/ai-router")
const vm = require("../brain/vector-memory")
const obs = require("../brain/observe")
const { createScheduledAgent } = require("../brain/agent-runtime")

async function run() {
  console.log("\n[LISTING AGENT] Starting -", new Date().toISOString())
  const start = Date.now()
  try {
    const db = await getDb()
    const pending = db.exec("SELECT * FROM properties WHERE status='pending'")
    const rows = pending[0]?.values || []
    const active = db.exec("SELECT * FROM properties WHERE status='active'")
    const activeRows = active[0]?.values || []
    console.log(`[LISTING AGENT] ${rows.length} pending | ${activeRows.length} active`)

    for (const row of rows) {
      const address = row[1]
      const type = row[2]
      const price = row[3]

      await obs.trace({ agent: "listing-agent", input: address }, async ({ span, score }) => {
        await checkBeforeActing(`listing-${type}`)
        const pastFailures = await vm.failures.recall(`listing ${type} property priced ${price}`, 3)
        if (pastFailures.length) {
          console.log("[VAULT] Semantic lessons:", pastFailures.map((f) => f.text.slice(0, 80)).join(" | "))
          span("vault-recall", { output: JSON.stringify(pastFailures), ms: 0 })
        }

        const tone = await ai.classify(
          `Property: ${address}, ${type}, $${price}. Pick best listing tone.`,
          ["professional-investor", "warm-residential", "industrial-practical"]
        )
        span("tone-pick", { output: tone, model: ai.MODEL_FAST })

        const lessons = pastFailures.length
          ? `\n\nPast lessons to avoid:\n${pastFailures.map((f) => "- " + f.text).join("\n")}`
          : ""

        const { text: copy, model, ms } = await ai.generate(
          `Write a professional MLS listing for: ${address}. Type: ${type}. Price: $${price}. Tone: ${tone}. Compelling, under 200 words, no markdown.${lessons}`,
          { task: "reason", maxTokens: 400 }
        )
        span("listing-copy", { input: address, output: copy.slice(0, 500), model, ms })

        if (copy) {
          await saveKnowledge(`listing-${address}`, copy.substring(0, 800), "listing-agent")
          db.run("UPDATE properties SET status='active' WHERE address=?", [address])
          save()
          await vm.deals.remember(
            `Listed ${address} (${type}, $${price}, ${tone}): ${copy.slice(0, 400)}`,
            { address, type, price, model }
          )
          score(0.85, "copy generated, saved, status flipped")
          console.log(`[LISTING AGENT] Copy via ${model} in ${ms}ms`)
        } else {
          score(0.2, "empty copy")
        }
      })
      await humanDelay(2000, 4000)
    }

    const dur = Math.round((Date.now() - start) / 1000)
    fs.mkdirSync("logs", { recursive: true })
    fs.writeFileSync("logs/last-listing-run.txt", new Date().toISOString())
    const msg = `GSB-100 Listing: ${rows.length} processed, ${activeRows.length} active. ${dur}s.`
    console.log("[LISTING AGENT]", msg)
    await sendAlert(msg)
  } catch (error) {
    await recordFailure({
      context: "listing-agent",
      whatHappened: error.message,
      rootCause: "runtime",
      neverDo: "check logs/listing-err.log",
      platform: "all",
      severity: "high",
    })
    try {
      await vm.failures.remember(`Listing agent crashed: ${error.message}`, { context: "listing-agent" })
    } catch {}
    await sendAlert(`GSB-100 ALERT: Listing agent - ${error.message}`)
  }
}

createScheduledAgent({
  name: "LISTING AGENT",
  schedule: "0 7 * * *",
  run,
})
