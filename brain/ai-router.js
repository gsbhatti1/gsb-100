require("dotenv").config()
const axios = require("axios")

const OLLAMA = process.env.OLLAMA_HOST || "http://localhost:11434"
const MODEL_FAST = process.env.MODEL_FAST || "llama3.2:3b"
const MODEL_FAST_BACKUP = process.env.MODEL_FAST_BACKUP || process.env.MODEL_REASON || "deepseek-r1:32b"
const MODEL_REASON = process.env.MODEL_REASON || "deepseek-r1:32b"
const MODEL_EMBED = process.env.MODEL_EMBED || "nomic-embed-text"

const TIMEOUT_FAST = 45_000
const TIMEOUT_REASON = 420_000
const TIMEOUT_EMBED = 20_000
const FAST_FAIL_COOLDOWN_MS = 30 * 60 * 1000

const state = {
  unhealthyUntil: {},
}

function now() {
  return Date.now()
}

function isCoolingDown(model) {
  return (state.unhealthyUntil[model] || 0) > now()
}

function markUnhealthy(model, reason) {
  state.unhealthyUntil[model] = now() + FAST_FAIL_COOLDOWN_MS
  console.warn(`[AI] ${model} cooling down for ${FAST_FAIL_COOLDOWN_MS / 60000}m: ${reason}`)
}

function clearUnhealthy(model) {
  delete state.unhealthyUntil[model]
}

function tinyPrompt(prompt = "") {
  const text = String(prompt).trim()
  return text.length > 0 && text.length <= 80
}

function needsReasoning(prompt = "") {
  const lower = prompt.toLowerCase()
  return (
    prompt.length > 600 ||
    /analyze|strategy|draft|write a|generate \d+ ideas|investment|proforma|compare|argue|pros and cons/i.test(lower)
  )
}

function pickModel(task, prompt) {
  if (task === "embed") return { model: MODEL_EMBED, timeout: TIMEOUT_EMBED, kind: "embed" }
  if (task === "reason") return { model: MODEL_REASON, timeout: TIMEOUT_REASON, kind: "reason" }

  if (task === "fast") {
    if (!isCoolingDown(MODEL_FAST)) {
      return { model: MODEL_FAST, timeout: TIMEOUT_FAST, kind: "fast" }
    }
    return { model: MODEL_FAST_BACKUP, timeout: TIMEOUT_REASON, kind: "fast-backup" }
  }

  if (needsReasoning(prompt)) {
    return { model: MODEL_REASON, timeout: TIMEOUT_REASON, kind: "reason" }
  }

  if (!isCoolingDown(MODEL_FAST)) {
    return {
      model: MODEL_FAST,
      timeout: tinyPrompt(prompt) ? Math.min(TIMEOUT_FAST, 20_000) : TIMEOUT_FAST,
      kind: "fast",
    }
  }

  return { model: MODEL_FAST_BACKUP, timeout: TIMEOUT_REASON, kind: "fast-backup" }
}

async function _call(model, prompt, timeout, opts = {}) {
  const keepAlive =
    opts.keepAlive ||
    (model === MODEL_REASON ? "2m" : model === MODEL_FAST ? "30m" : "15m")

  const body = {
    model,
    prompt,
    stream: false,
    keep_alive: keepAlive,
    think: opts.think ?? false,
    options: {
      temperature: opts.temperature ?? 0.7,
      num_predict: opts.maxTokens ?? 1024,
    },
  }

  const response = await axios.post(`${OLLAMA}/api/generate`, body, { timeout })
  return (response.data?.response || "").trim()
}

function isBadFastError(message = "") {
  return /timeout|econnreset|socket hang up|connection aborted|503|500/i.test(message)
}

async function generate(prompt, opts = {}) {
  const { task, retry = true } = opts
  const chosen = pickModel(task, prompt)
  const start = now()

  try {
    let out = await _call(chosen.model, prompt, chosen.timeout, opts)

    if (!out && chosen.kind === "fast" && retry) {
      console.log(`[AI] ${chosen.model} returned empty, escalating to ${MODEL_REASON}`)
      out = await _call(MODEL_REASON, prompt, TIMEOUT_REASON, opts)
      const ms = now() - start
      return { text: out, model: MODEL_REASON, ms, retried: true }
    }

    clearUnhealthy(chosen.model)
    const ms = now() - start
    console.log(`[AI] ${chosen.model} ${ms}ms ${out.length}ch`)
    return { text: out, model: chosen.model, ms }
  } catch (error) {
    const ms = now() - start
    const message = error.message || String(error)
    console.error(`[AI] ${chosen.model} FAIL ${ms}ms: ${message}`)

    if (chosen.kind === "fast" && isBadFastError(message)) {
      markUnhealthy(chosen.model, message)
    }

    if (!retry) {
      return { text: "", model: chosen.model, ms, error: message }
    }

    const fallbackModel = chosen.kind === "fast" ? MODEL_FAST_BACKUP : MODEL_REASON
    const fallbackTimeout = fallbackModel === MODEL_REASON ? TIMEOUT_REASON : TIMEOUT_FAST

    try {
      console.log(`[AI] fallback to ${fallbackModel}`)
      const out = await _call(fallbackModel, prompt, fallbackTimeout, opts)
      const totalMs = now() - start
      return { text: out, model: fallbackModel, ms: totalMs, retried: true }
    } catch (fallbackError) {
      const fallbackMessage = fallbackError.message || String(fallbackError)
      console.error(`[AI] fallback FAIL: ${fallbackMessage}`)
      return { text: "", model: fallbackModel, ms: now() - start, error: fallbackMessage }
    }
  }
}

async function classify(prompt, labels) {
  const wrapped = `Classify this into exactly one label from: ${labels.join(", ")}\n\nInput: ${prompt}\n\nReply with only the label, nothing else.`
  const { text } = await generate(wrapped, { task: "fast", temperature: 0.1, maxTokens: 32 })
  const match = labels.find((label) => text.toLowerCase().includes(label.toLowerCase()))
  return match || labels[0]
}

async function json(prompt, schema) {
  const wrapped = `${prompt}\n\nReply with ONLY valid JSON matching this schema: ${JSON.stringify(schema)}\nNo prose, no markdown fences.`
  const { text } = await generate(wrapped, { task: "fast", temperature: 0.2, maxTokens: 512 })
  try {
    const cleaned = text.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim()
    return JSON.parse(cleaned)
  } catch {
    return null
  }
}

async function warmup() {
  console.log("[AI] warming model stack...")
  const models = [MODEL_FAST].filter((value, index, array) => array.indexOf(value) === index)
  for (const model of models) {
    try {
      const timeout = 30_000
      await _call(model, "ok", timeout, { maxTokens: 4, temperature: 0 })
      clearUnhealthy(model)
      console.log(`[AI] ${model} ready`)
    } catch (error) {
      console.error(`[AI] ${model} warmup failed:`, error.message)
      if (model === MODEL_FAST) markUnhealthy(model, error.message)
    }
  }
}

module.exports = {
  generate,
  classify,
  json,
  warmup,
  MODEL_FAST,
  MODEL_FAST_BACKUP,
  MODEL_REASON,
  MODEL_EMBED,
}

if (require.main === module) {
  ;(async () => {
    console.log("[AI ROUTER] Self-test...")
    const fast = await generate("What is 2+2? Reply with one number only.", {
      task: "fast",
      temperature: 0,
      maxTokens: 8,
    })
    console.log("fast:", fast.model, fast.text.slice(0, 80) || "(empty)", fast.error || "")

    const reason = await generate(
      "Write one short sentence describing Utah commercial real estate conditions in 2026.",
      { task: "reason", temperature: 0.2, maxTokens: 48, think: false }
    )
    console.log("reason:", reason.model, reason.text.slice(0, 200) || "(empty)", reason.error || "")

    const picked = await classify(
      "This property sits on a main arterial near downtown",
      ["residential", "commercial", "industrial"]
    )
    console.log("classify:", picked)
    process.exit(0)
  })()
}
