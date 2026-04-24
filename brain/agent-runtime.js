require("dotenv").config()
const cron = require("node-cron")

const TIMEZONE = process.env.AGENT_TIMEZONE || "America/Los_Angeles"

function createScheduledAgent({ name, schedule, run }) {
  let running = false

  async function runSafely(trigger = "cron") {
    if (running) {
      console.log(`[${name}] Skip ${trigger}: previous run still active`)
      return
    }

    running = true
    console.log(`[${name}] Triggered by ${trigger}`)
    try {
      await run()
    } finally {
      running = false
    }
  }

  const runNow =
    process.argv.includes("--run-now") ||
    process.env.RUN_ONCE === "1" ||
    process.env.RUN_NOW === "1"

  if (runNow) {
    runSafely("manual")
      .then(() => process.exit(0))
      .catch(() => process.exit(1))
    return
  }

  console.log(`[${name}] Scheduler armed: ${schedule} (${TIMEZONE})`)
  cron.schedule(schedule, () => {
    runSafely("schedule").catch((error) => {
      console.error(`[${name}] Scheduled run failed:`, error.message)
    })
  }, { timezone: TIMEZONE })

  // Keep the process resident under PM2; these agents are now schedulers, not one-shot jobs.
  setInterval(() => {}, 60 * 60 * 1000)
}

module.exports = { createScheduledAgent, TIMEZONE }
