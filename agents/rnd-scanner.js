require("dotenv").config()
const fs = require("fs")
const { saveKnowledge, saveIdea, getNewIdeas } = require("../brain/memory-store")
const { sendAlert } = require("../notifications/alert")
const ai = require("../brain/ai-router")
const vm = require("../brain/vector-memory")
const obs = require("../brain/observe")
const { createScheduledAgent } = require("../brain/agent-runtime")

const TOPICS = [
  "Utah commercial real estate 2026",
  "SLC office vacancy rates",
  "AppFolio alternatives property management",
  "real estate AI tools 2026",
  "Utah residential inventory prices",
  "commercial leasing retail industrial Utah",
  "real estate investment Utah ROI",
  "Utah broker competitor analysis",
]

async function run() {
  console.log("\n[R&D SCANNER] Starting -", new Date().toISOString())

  await obs.trace(
    { agent: "rnd-scanner", input: `weekly-scan-${new Date().toDateString()}` },
    async ({ span, score }) => {
      for (const topic of TOPICS) {
        await saveKnowledge(topic, `Scanned ${new Date().toDateString()}`, "weekly-rnd")
        await vm.market.remember(`R&D topic scanned: ${topic}`, { topic })
        process.stdout.write(".")
      }
      console.log(`\n[R&D] ${TOPICS.length} topics logged`)
      span("topics", { output: TOPICS.join(", "), ms: 0 })

      const marketContext = await vm.market.recall("Utah real estate opportunities 2026", 8)
      const failureContext = await vm.failures.recall("real estate idea didn't work", 3)

      const contextBlock = [
        marketContext.length ? "Prior market observations:\n" + marketContext.map((m) => "- " + m.text).join("\n") : "",
        failureContext.length ? "Failed ideas to avoid:\n" + failureContext.map((f) => "- " + f.text).join("\n") : "",
      ]
        .filter(Boolean)
        .join("\n\n")

      console.log("[R&D] Generating ideas with reasoning model...")
      const prompt = `You are the strategic brain for GBS Realty (gsbrealtor.com) Salt Lake City Utah. Date: ${new Date().toDateString()}.

${contextBlock ? contextBlock + "\n\n" : ""}Generate 3 high-value business ideas.
For each:
IDEA: [title]
WHY: [why it matters for Utah 2026]
DIFFICULTY: [Easy/Medium/Complex]
STEPS: [3 actions]
---
Think big. Be specific to Utah real estate. Avoid repeats of failed ideas above.`

      const { text: ideas, model, ms } = await ai.generate(prompt, { task: "reason", maxTokens: 1400 })
      span("ideas", { output: (ideas || "").slice(0, 1000), model, ms })

      if (ideas && ideas.length > 50) {
        await saveIdea(
          `Ideas ${new Date().toDateString()}`,
          ideas.substring(0, 2000),
          `Generated via ${model}`,
          "varies",
          "Review Friday, pick top 1",
          "rnd-weekly"
        )
        const chunks = ideas.split(/---+/).map((s) => s.trim()).filter((chunk) => chunk.length > 30)
        for (const chunk of chunks) {
          await vm.market.remember(`R&D idea ${new Date().toDateString()}: ${chunk.slice(0, 500)}`, {
            week: new Date().toDateString(),
          })
        }
        console.log("\n[R&D] IDEAS:\n", ideas.substring(0, 600))
        score(0.85, "ideas generated and parsed")
      } else {
        score(0.1, "empty or too-short ideas output")
      }

      const all = await getNewIdeas()
      const msg = `GSB-100 R&D: ${TOPICS.length} topics, ${all.length} ideas in DB. ${model} ${ms}ms.`
      console.log("[R&D]", msg)
      fs.mkdirSync("logs", { recursive: true })
      fs.writeFileSync("logs/last-rnd-run.txt", new Date().toISOString())
      await sendAlert(msg)
    }
  )
}

async function runWithCrashHandling() {
  try {
    await run()
  } catch (error) {
    console.error("[R&D] crashed:", error.message)
    try {
      await vm.failures.remember(`R&D scanner crashed: ${error.message}`, { context: "rnd-scanner" })
    } catch {}
    await sendAlert(`GSB-100 ALERT: R&D scanner - ${error.message}`).catch(() => {})
    throw error
  }
}

createScheduledAgent({
  name: "R&D SCANNER",
  schedule: "0 8 * * 5",
  run: runWithCrashHandling,
})
