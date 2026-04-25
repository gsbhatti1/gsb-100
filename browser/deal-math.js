function parseMoney(text) {
  if (!text) return null
  const cleaned = String(text).replace(/,/g, "").trim()
  const match = cleaned.match(/\$?\s*([\d.]+)\s*([mbk])?/i)
  if (!match) return null
  let value = Number(match[1])
  const suffix = (match[2] || "").toLowerCase()
  if (suffix === "m") value *= 1_000_000
  if (suffix === "b") value *= 1_000_000_000
  if (suffix === "k") value *= 1_000
  return Number.isFinite(value) ? value : null
}

function parsePercent(text) {
  const match = String(text || "").match(/([\d.]+)\s*%/)
  return match ? Number(match[1]) : null
}

function payment(principal, annualRatePct, years) {
  if (!principal || !annualRatePct || !years) return null
  const r = annualRatePct / 100 / 12
  const n = years * 12
  const factor = Math.pow(1 + r, n)
  return principal * ((r * factor) / (factor - 1))
}

function annualDebtService(principal, annualRatePct, years) {
  const monthly = payment(principal, annualRatePct, years)
  return monthly ? monthly * 12 : null
}

function capRate(noi, price) {
  if (!noi || !price) return null
  return (noi / price) * 100
}

function cashOnCash(noi, price, annualRatePct, years, downPct) {
  if (!noi || !price || !downPct) return null
  const downPayment = price * (downPct / 100)
  const principal = price - downPayment
  const debt = annualDebtService(principal, annualRatePct, years)
  if (!debt || downPayment <= 0) return null
  const annualCashFlow = noi - debt
  return {
    downPayment,
    principal,
    annualDebtService: debt,
    annualCashFlow,
    roiPct: (annualCashFlow / downPayment) * 100,
  }
}

function fmtMoney(value) {
  if (value == null) return "n/a"
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value)
}

function fmtPct(value) {
  if (value == null || Number.isNaN(value)) return "n/a"
  return `${value.toFixed(2)}%`
}

module.exports = {
  parseMoney,
  parsePercent,
  payment,
  annualDebtService,
  capRate,
  cashOnCash,
  fmtMoney,
  fmtPct,
}
