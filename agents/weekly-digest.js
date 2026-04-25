// GSB-100 Weekly Digest agent
// One Sunday 09:00 PT send, tying the whole week into one readable message.
// Runs under PM2 as a resident scheduler (same pattern as GC / agents).
require("dotenv").config()
const { createScheduledAgent } = require("../brain/agent-runtime")
const { sendWeeklyDigest } = require("../notifications/mission-control")

async function run() {
  console.log("[WEEKLY] building digest —", new Date().toISOString())
  await sendWeeklyDigest()
}

createScheduledAgent({
  name: "WEEKLY",
  schedule: "0 9 * * 0", // Sunday 09:00 in AGENT_TIMEZONE (defaults to America/Los_Angeles)
  run,
})
