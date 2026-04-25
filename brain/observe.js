// GSB-100 Observability — trace every agent action to Langfuse (self-hosted)
// Zero-dependency HTTP ingest. If Langfuse is down or unset, logs to brain.db action_log
// so nothing is ever lost.
//
// The point of this module: you review a weekly digest of agent quality. If the agent
// is drifting — bad listing copy, noisy buyer matches, junk R&D ideas — you see it
// before it costs you a client.
require("dotenv").config()
const axios = require("axios")
const { logAction } = require("./memory-store")

const HOST = process.env.LANGFUSE_HOST || ""    // e.g. http://localhost:3000
const PK = process.env.LANGFUSE_PUBLIC_KEY || ""
const SK = process.env.LANGFUSE_SECRET_KEY || ""
const auth = (PK && SK) ? { username: PK, password: SK } : null

function uid() { return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}` }
const _traces = new Map()

// Start a trace for one agent run (listing-agent invocation, buyer-agent run, etc.)
function startTrace({ agent, input, userId = "gsb-owner" }) {
  const id = uid()
  const trace = {
    id, agent, userId, input,
    startedAt: Date.now(),
    spans: [],
    score: null,
  }
  _traces.set(id, trace)
  return id
}

// Record one span inside a trace — a single AI call, DB hit, or tool invocation
function span(traceId, { name, input, output, model, ms, metadata = {} }) {
  const trace = _traces.get(traceId)
  if (!trace) return
  trace.spans.push({
    name, input, output, model, ms, metadata,
    ts: new Date().toISOString(),
  })
}

// Score the trace — 0..1 quality rating. Agent self-scores OR a reviewer does it later.
function score(traceId, value, reason = "") {
  const trace = _traces.get(traceId)
  if (trace) trace.score = { value, reason }
}

// Finish and flush to Langfuse (or fallback to action_log)
async function endTrace(traceId, { output, success = true } = {}) {
  const trace = _traces.get(traceId); if (!trace) return
  trace.output = output
  trace.success = success
  trace.endedAt = Date.now()
  trace.durationMs = trace.endedAt - trace.startedAt

  _traces.delete(traceId)

  // Always mirror a summary into SQLite action_log — durable, queryable forever
  try {
    await logAction(
      trace.agent,
      (trace.input || "").slice(0, 300),
      JSON.stringify({
        spans: trace.spans.length,
        duration_ms: trace.durationMs,
        score: trace.score,
      })
    )
  } catch (e) { /* non-fatal */ }

  // Push to Langfuse if configured
  if (!HOST || !auth) return
  try {
    const batch = {
      batch: [
        {
          id: uid(), timestamp: new Date(trace.startedAt).toISOString(),
          type: "trace-create",
          body: {
            id: trace.id, name: trace.agent, userId: trace.userId,
            input: trace.input, output: trace.output,
            metadata: { durationMs: trace.durationMs, success },
          },
        },
        ...trace.spans.map(s => ({
          id: uid(), timestamp: s.ts, type: "span-create",
          body: {
            id: uid(), traceId: trace.id, name: s.name,
            input: (s.input || "").slice(0, 1000),
            output: (s.output || "").slice(0, 2000),
            metadata: { model: s.model, ms: s.ms, ...s.metadata },
          },
        })),
        ...(trace.score ? [{
          id: uid(), timestamp: new Date().toISOString(), type: "score-create",
          body: { id: uid(), traceId: trace.id, name: "quality",
                  value: trace.score.value, comment: trace.score.reason },
        }] : []),
      ],
    }
    await axios.post(`${HOST}/api/public/ingestion`, batch, { auth, timeout: 5000 })
  } catch (e) {
    console.error("[OBS] Langfuse push failed (non-fatal):", e.message)
  }
}

// Convenience wrapper: run `fn` inside a trace
async function trace({ agent, input }, fn) {
  const id = startTrace({ agent, input })
  try {
    const out = await fn({ traceId: id, span: (name, data) => span(id, { name, ...data }), score: (v, r) => score(id, v, r) })
    let serialized = ""
    if (typeof out === "string") {
      serialized = out.slice(0, 2000)
    } else if (out !== undefined && out !== null) {
      try { serialized = (JSON.stringify(out) || "").slice(0, 2000) }
      catch { serialized = String(out).slice(0, 2000) }
    }
    await endTrace(id, { output: serialized, success: true })
    return out
  } catch (e) {
    await endTrace(id, { output: `ERROR: ${e.message}`, success: false })
    throw e
  }
}

module.exports = { startTrace, span, score, endTrace, trace }
