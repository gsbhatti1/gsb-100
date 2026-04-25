require("dotenv").config()
const fs = require("fs")
const path = require("path")
const { getDb } = require("../brain/memory-store")

const OUTPUT = path.join(process.cwd(), "docs", "buyer-tracker.html")

function safe(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function fmtMoney(value) {
  if (value == null || value === "") return "-"
  const num = Number(value)
  if (!Number.isFinite(num)) return safe(value)
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(num)
}

async function run() {
  const db = await getDb()
  const sql = `
    SELECT
      b.id,
      b.name,
      b.phone,
      b.email,
      b.criteria_json,
      b.active,
      COUNT(m.id) AS match_count,
      SUM(CASE WHEN m.sent = 1 THEN 1 ELSE 0 END) AS sent_count,
      MAX(m.found_at) AS last_match_at
    FROM buyers b
    LEFT JOIN buyer_matches m ON m.buyer_id = b.id
    GROUP BY b.id, b.name, b.phone, b.email, b.criteria_json, b.active
    ORDER BY b.id DESC
  `

  const stmt = db.prepare(sql)
  const rows = []
  while (stmt.step()) rows.push(stmt.getAsObject())
  stmt.free()

  const cards = rows.map((row) => {
    let criteria = {}
    try { criteria = JSON.parse(row.criteria_json || "{}") } catch {}
    const maxPrice = criteria.maxPrice ? fmtMoney(criteria.maxPrice) : "-"
    const type = criteria.type || "-"
    const location = criteria.location || "-"
    const keywords = Array.isArray(criteria.keywords) ? criteria.keywords.join(", ") : "-"
    const needs = criteria.raw || "-"
    const status = Number(row.active) === 1 ? "Active" : "Inactive"

    return `
      <tr>
        <td>${safe(row.id)}</td>
        <td>
          <div class="buyer-name">${safe(row.name)}</div>
          <div class="buyer-meta">${safe(row.phone || "-")} | ${safe(row.email || "-")}</div>
        </td>
        <td>${safe(type)}</td>
        <td>${safe(location)}</td>
        <td>${safe(maxPrice)}</td>
        <td>${safe(needs)}</td>
        <td>${safe(keywords)}</td>
        <td>${safe(status)}</td>
        <td>${safe(row.match_count || 0)}</td>
        <td>${safe(row.sent_count || 0)}</td>
        <td>${safe(row.last_match_at || "-")}</td>
      </tr>
    `
  }).join("")

  const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>GSB-100 Buyer Tracker</title>
    <style>
      :root {
        --bg: #f4f7fb;
        --card: #ffffff;
        --line: #dbe3ea;
        --ink: #102033;
        --muted: #617487;
        --blue: #0e6ba8;
        --green: #1a8f5a;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        background: linear-gradient(180deg, #eef4f9 0%, var(--bg) 100%);
        color: var(--ink);
        font-family: Arial, Helvetica, sans-serif;
      }
      .wrap {
        max-width: 1500px;
        margin: 0 auto;
        padding: 28px;
      }
      .hero {
        background: var(--card);
        border: 1px solid var(--line);
        padding: 22px 24px;
        margin-bottom: 18px;
        box-shadow: 0 10px 30px rgba(16, 32, 51, 0.06);
      }
      .title {
        font-size: 30px;
        font-weight: 700;
        letter-spacing: 0.5px;
      }
      .sub {
        margin-top: 8px;
        color: var(--muted);
        font-size: 14px;
      }
      .table-wrap {
        background: var(--card);
        border: 1px solid var(--line);
        overflow: auto;
        box-shadow: 0 10px 30px rgba(16, 32, 51, 0.06);
      }
      table {
        width: 100%;
        border-collapse: collapse;
        min-width: 1300px;
      }
      th, td {
        padding: 14px 12px;
        border-bottom: 1px solid var(--line);
        vertical-align: top;
        text-align: left;
        font-size: 13px;
        line-height: 19px;
      }
      th {
        position: sticky;
        top: 0;
        background: #f8fbfd;
        color: var(--muted);
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.8px;
      }
      .buyer-name {
        font-size: 15px;
        font-weight: 700;
        color: var(--ink);
      }
      .buyer-meta {
        color: var(--muted);
        margin-top: 4px;
      }
      .footer {
        margin-top: 12px;
        color: var(--muted);
        font-size: 12px;
      }
      .empty {
        padding: 24px;
        color: var(--muted);
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="hero">
        <div class="title">GSB-100 Buyer Tracker</div>
        <div class="sub">Track every buyer you add, their needs, and how many deals the system has found for them.</div>
      </div>
      <div class="table-wrap">
        ${rows.length ? `
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Buyer</th>
              <th>Type</th>
              <th>State / Area</th>
              <th>Budget</th>
              <th>Needs</th>
              <th>Keywords</th>
              <th>Status</th>
              <th>Matches</th>
              <th>Sent</th>
              <th>Last Match</th>
            </tr>
          </thead>
          <tbody>${cards}</tbody>
        </table>` : `<div class="empty">No buyers added yet.</div>`}
      </div>
      <div class="footer">Generated from C:/gsb-100/data/brain.db</div>
    </div>
  </body>
</html>`

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true })
  fs.writeFileSync(OUTPUT, html)
  console.log(`[BUYER DASHBOARD] Wrote ${OUTPUT}`)
}

run().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
