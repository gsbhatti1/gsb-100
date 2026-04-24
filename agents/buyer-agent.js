require("dotenv").config()
const fs = require("fs")
const { getActiveBuyers, saveKnowledge } = require("../brain/memory-store")
const { recordFailure } = require("../brain/failure-vault")
const { sendAlert } = require("../notifications/alert")
const { humanDelay } = require("../browser/playwright-config")
const ai = require("../brain/ai-router")
const vm = require("../brain/vector-memory")
const obs = require("../brain/observe")
const { createScheduledAgent } = require("../brain/agent-runtime")

async function run() {
  console.log("\n[BUYER AGENT] Starting -", new Date().toISOString())
  try {
    const buyers = await getActiveBuyers()
    console.log(`[BUYER AGENT] ${buyers.length} active buyers`)

    for (const buyer of buyers) {
      const criteria = JSON.parse(buyer.criteria_json || "{}")

      await obs.trace({ agent: "buyer-agent", input: buyer.name }, async ({ span, score }) => {
        const priorNotes = await vm.clients.recall(`${buyer.name} ${JSON.stringify(criteria)}`, 5)
        if (priorNotes.length) {
          span("prior-context", { output: priorNotes.map((n) => n.text).join(" | ").slice(0, 500), ms: 0 })
        }

        const priorBlock = priorNotes.length
          ? `\nPrior context for this buyer:\n${priorNotes.map((n) => "- " + n.text).join("\n")}\n`
          : ""

        const prompt = `You are a Utah real estate buyer agent. Client: ${buyer.name}. Needs: ${JSON.stringify(criteria)}.${priorBlock}
List 5 specific, platform-specific search strategies for LoopNet, Crexi, CoStar, Utah MLS, and gsbrealtor.com.
For each: the exact filter set, the signal to watch, and a 1-line match rationale. Utah 2026 market context.`

        const { text: strategy, model, ms } = await ai.generate(prompt, { task: "reason", maxTokens: 800 })
        span("strategy", { input: buyer.name, output: strategy.slice(0, 600), model, ms })

        if (strategy) {
          await saveKnowledge(`buyer-strategy-${buyer.name}`, strategy.slice(0, 1500), "buyer-agent")
          await vm.clients.remember(
            `Buyer ${buyer.name} (${JSON.stringify(criteria)}) strategy: ${strategy.slice(0, 500)}`,
            { buyer_id: buyer.id }
          )
          console.log(`[BUYER AGENT] ${buyer.name} strategy via ${model} in ${ms}ms`)
          score(0.75, "strategy produced and stored")
        } else {
          score(0.1, "empty strategy")
        }
      })
      await humanDelay(3000, 6000)
    }

    fs.mkdirSync("logs", { recursive: true })
    fs.writeFileSync("logs/last-buyer-run.txt", new Date().toISOString())
    const msg = `GSB-100 Buyer: ${buyers.length} buyer(s) processed.`
    console.log("[BUYER AGENT]", msg)
    await sendAlert(msg)
  } catch (error) {
    await recordFailure({
      context: "buyer-agent",
      whatHappened: error.message,
      rootCause: "runtime",
      neverDo: "check logs/buyer-err.log",
      platform: "all",
    })
    await sendAlert(`GSB-100 ALERT: Buyer agent - ${error.message}`)
  }
}

createScheduledAgent({
  name: "BUYER AGENT",
  schedule: "0 6 * * *",
  run,
})
