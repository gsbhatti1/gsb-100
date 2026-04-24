// GSB-100 Vector Memory
// Semantic memory over failures, deals, client notes, market observations.
// Uses nomic-embed-text (300MB, Ollama) for embeddings + Chroma HTTP API for storage.
// Falls back gracefully if Chroma isn't up — system still works, just without semantic recall.
require("dotenv").config()
const axios = require("axios")

const OLLAMA = process.env.OLLAMA_HOST || "http://localhost:11434"
const EMBED_MODEL = process.env.EMBED_MODEL || "nomic-embed-text"
const CHROMA = process.env.CHROMA_HOST || "http://localhost:8000"
const ENABLED = process.env.VECTOR_MEMORY_ENABLED !== "0"
const TENANT = "default_tenant"
const DATABASE = "default_database"
const CHROMA_TIMEOUT_MS = 1500
const CHROMA_COOLDOWN_MS = 10 * 60 * 1000

let collectionCache = {}
let chromaUnavailableUntil = 0

function chromaAvailable() {
  return ENABLED && Date.now() >= chromaUnavailableUntil
}

function markChromaUnavailable(reason) {
  chromaUnavailableUntil = Date.now() + CHROMA_COOLDOWN_MS
  console.error(`[CHROMA] cooling down for ${CHROMA_COOLDOWN_MS / 60000}m:`, reason)
}

async function embed(text) {
  if (!chromaAvailable()) return null
  try {
    const r = await axios.post(`${OLLAMA}/api/embeddings`, {
      model: EMBED_MODEL, prompt: text
    }, { timeout: 10000 })
    return r.data.embedding
  } catch (e) {
    console.error("[EMBED]", e.message)
    return null
  }
}

async function getCollection(name) {
  if (!chromaAvailable()) return null
  if (collectionCache[name]) return collectionCache[name]
  try {
    // v2 API — ensure collection exists
    const url = `${CHROMA}/api/v2/tenants/${TENANT}/databases/${DATABASE}/collections`
    const r = await axios.post(url, {
      name,
      metadata: { "hnsw:space": "cosine" },
      get_or_create: true,
    }, { timeout: CHROMA_TIMEOUT_MS })
    collectionCache[name] = r.data.id
    return r.data.id
  } catch (e) {
    markChromaUnavailable(`collection ${name} unavailable: ${e.message}`)
    return null
  }
}

// Record a memory — any text with optional metadata
async function remember(collection, text, metadata = {}) {
  if (!chromaAvailable()) return false
  const cid = await getCollection(collection)
  if (!cid) return false
  const vector = await embed(text)
  if (!vector) return false
  const id = `${collection}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  try {
    await axios.post(
      `${CHROMA}/api/v2/tenants/${TENANT}/databases/${DATABASE}/collections/${cid}/add`,
      {
        ids: [id],
        embeddings: [vector],
        documents: [text],
        metadatas: [{ ...metadata, ts: new Date().toISOString() }],
      },
      { timeout: CHROMA_TIMEOUT_MS }
    )
    return id
  } catch (e) {
    markChromaUnavailable(`add failed: ${e.message}`); return false
  }
}

// Semantic search — return top k similar memories
async function recall(collection, query, k = 5) {
  if (!chromaAvailable()) return []
  const cid = await getCollection(collection)
  if (!cid) return []
  const vector = await embed(query)
  if (!vector) return []
  try {
    const r = await axios.post(
      `${CHROMA}/api/v2/tenants/${TENANT}/databases/${DATABASE}/collections/${cid}/query`,
      { query_embeddings: [vector], n_results: k },
      { timeout: CHROMA_TIMEOUT_MS }
    )
    const docs = r.data.documents?.[0] || []
    const metas = r.data.metadatas?.[0] || []
    const dists = r.data.distances?.[0] || []
    return docs.map((d, i) => ({ text: d, meta: metas[i], similarity: 1 - (dists[i] || 0) }))
  } catch (e) {
    markChromaUnavailable(`query failed: ${e.message}`); return []
  }
}

// Specialized wrappers — one per memory domain
const failures = {
  remember: (text, meta) => remember("failures", text, meta),
  recall: (q, k) => recall("failures", q, k),
}
const deals = {
  remember: (text, meta) => remember("deals", text, meta),
  recall: (q, k) => recall("deals", q, k),
}
const clients = {
  remember: (text, meta) => remember("clients", text, meta),
  recall: (q, k) => recall("clients", q, k),
}
const market = {
  remember: (text, meta) => remember("market", text, meta),
  recall: (q, k) => recall("market", q, k),
}

module.exports = { embed, remember, recall, failures, deals, clients, market }

// Self-test
if (require.main === module) {
  (async () => {
    console.log("[VECTOR] Testing…")
    const v = await embed("Utah commercial office vacancy is rising")
    console.log("[VECTOR] embed ok, dim=", v?.length || "NONE")
    if (!v) { console.error("Ollama embed model not pulled. Run: ollama pull nomic-embed-text"); process.exit(1) }
    const id = await failures.remember("Listed 123 Main St at $500k — sat 90 days, overpriced vs comps by 12%", { tag: "pricing" })
    console.log("[VECTOR] remember:", id)
    const hits = await failures.recall("property priced above market comps", 3)
    console.log("[VECTOR] recall:", JSON.stringify(hits, null, 2))
    process.exit(0)
  })()
}
