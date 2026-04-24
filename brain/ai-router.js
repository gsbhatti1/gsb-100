// GSB-100 AI Router
// Routes requests across a model stack so the 32B doesn't get called for everything.
//
//   fast     → qwen2.5:3b        classification, routing, short answers, JSON shaping
//   reason   → deepseek-r1:32b   listing copy, investment analysis, strategy
//   embed    → nomic-embed-text  vector memory
//
// Auto-routes by task hint OR by heuristics (token count, keywords).
// Retries once on transient Ollama errors. Falls back fast→reason if fast returns empty.
require("dotenv").config()
const axios = require("axios")

const OLLAMA = process.env.OLLAMA_HOST || "http://localhost:11434"
const MODEL_FAST   = process.env.MODEL_FAST   || "qwen2.5:3b"
const MODEL_REASON = process.env.MODEL_REASON || "deepseek-r1:32b"
const MODEL_EMBED  = process.env.MODEL_EMBED  || "nomic-embed-text"

// Per-model timeout budgets. Small = fast; Big = patient.
const TIMEOUT_FAST   = 90_000
const TIMEOUT_REASON = 420_000   // 7 min on Windows or cold model starts
const TIMEOUT_EMBED  = 20_000

function pickModel(task, prompt) {
  if (task === "fast") return { model: MODEL_FAST, timeout: TIMEOUT_FAST }
  if (task === "reason") return { model: MODEL_REASON, timeout: TIMEOUT_REASON }
  if (task === "embed") return { model: MODEL_EMBED, timeout: TIMEOUT_EMBED }
  // Heuristic auto-routing
  const lower = (prompt || "").toLowerCase()
  const needsReasoning =
    prompt.length > 600 ||
    /analyze|strategy|draft|write a|generate \d+ ideas|investment|proforma|compare|argue|pros and cons/i.test(lower)
  return needsReasoning
    ? { model: MODEL_REASON, timeout: TIMEOUT_REASON }
    : { model: MODEL_FAST, timeout: TIMEOUT_FAST }
}

async function _call(model, prompt, timeout, opts = {}) {
  const body = {
    model,
    prompt,
    stream: false,
    keep_alive: "30m",
    options: {
      temperature: opts.temperature ?? 0.7,
      num_predict: opts.maxTokens ?? 1024,
    },
  }
  const r = await axios.post(`${OLLAMA}/api/generate`, body, { timeout })
  return (r.data?.response || "").trim()
}

async function generate(prompt, opts = {}) {
  const { task, retry = true } = opts
  const { model, timeout } = pickModel(task, prompt)
  const start = Date.now()
  try {
    let out = await _call(model, prompt, timeout, opts)
    // If fast model returned garbage/empty, escalate to reasoning model once
    if ((!out || out.length < 10) && model === MODEL_FAST && retry) {
      console.log(`[AI] fast empty, escalating to ${MODEL_REASON}`)
      out = await _call(MODEL_REASON, prompt, TIMEOUT_REASON, opts)
    }
    const ms = Date.now() - start
    console.log(`[AI] ${model} ${ms}ms ${out.length}ch`)
    return { text: out, model, ms }
  } catch (e) {
    const ms = Date.now() - start
    console.error(`[AI] ${model} FAIL ${ms}ms:`, e.message)
    // One-shot retry on timeout/network; escalate fast→reason
    if (retry) {
      const next = model === MODEL_FAST ? MODEL_REASON : model
      try {
        const out = await _call(next, prompt, next === MODEL_REASON ? TIMEOUT_REASON : timeout, opts)
        return { text: out, model: next, ms: Date.now() - start, retried: true }
      } catch (e2) {
        console.error(`[AI] retry FAIL:`, e2.message)
        return { text: "", model: next, ms: Date.now() - start, error: e2.message }
      }
    }
    return { text: "", model, ms, error: e.message }
  }
}

async function classify(prompt, labels) {
  const p = `Classify this into exactly one label from: ${labels.join(", ")}\n\nInput: ${prompt}\n\nReply with only the label, nothing else.`
  const { text } = await generate(p, { task: "fast", temperature: 0.1, maxTokens: 32 })
  const match = labels.find(l => text.toLowerCase().includes(l.toLowerCase()))
  return match || labels[0]
}

async function json(prompt, schema) {
  const p = `${prompt}\n\nReply with ONLY valid JSON matching this schema: ${JSON.stringify(schema)}\nNo prose, no markdown fences.`
  const { text } = await generate(p, { task: "fast", temperature: 0.2, maxTokens: 1024 })
  try {
    const cleaned = text.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim()
    return JSON.parse(cleaned)
  } catch { return null }
}

async function warmup() {
  console.log("[AI] warming model stack…")
  for (const m of [MODEL_FAST, MODEL_REASON]) {
    try {
      await _call(m, "ok", m === MODEL_REASON ? 180_000 : 90_000, { maxTokens: 4 })
      console.log(`[AI] ${m} ready`)
    } catch (e) { console.error(`[AI] ${m} warmup failed:`, e.message) }
  }
}

module.exports = { generate, classify, json, warmup, MODEL_FAST, MODEL_REASON, MODEL_EMBED }

if (require.main === module) {
  (async () => {
    console.log("[AI ROUTER] Self-test…")
    const a = await generate("What is 2+2?")
    console.log("fast:", a.model, a.text.slice(0, 80))
    const b = await generate("Analyze the Utah commercial real estate market for Q2 2026. Consider vacancy rates, interest rates, and local migration patterns. Give me 3 actionable strategies.")
    console.log("reason:", b.model, b.text.slice(0, 200))
    const c = await classify("This property sits on a main arterial near downtown", ["residential", "commercial", "industrial"])
    console.log("classify:", c)
    process.exit(0)
  })()
}
