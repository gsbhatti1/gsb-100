require("dotenv").config()
const axios = require("axios")
const nodemailer = require("nodemailer")

const hasEmail = process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD
const transporter = hasEmail
  ? nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
      },
    })
  : null

async function sendTelegram(msg, chatId = process.env.TELEGRAM_CHAT_ID) {
  if (!process.env.TELEGRAM_BOT_TOKEN || !chatId) {
    throw new Error("Telegram is not configured")
  }

  const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`
  await axios.post(
    url,
    {
      chat_id: chatId,
      text: msg,
    },
    { timeout: 15000 }
  )

  console.log(`[TELEGRAM] Sent: ${msg.substring(0, 80)}`)
}

async function sendSmsFallback(msg) {
  if (!transporter || !process.env.TMOBILE_GATEWAY) {
    throw new Error("SMS fallback is not configured")
  }

  await transporter.sendMail({
    from: process.env.GMAIL_USER,
    to: process.env.TMOBILE_GATEWAY,
    subject: "GSB-100",
    text: msg,
  })

  console.log(`[SMS] Sent: ${msg.substring(0, 80)}`)
}

async function sendAlert(msg) {
  try {
    if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
      await sendTelegram(msg)
      return
    }

    await sendSmsFallback(msg)
  } catch (e) {
    console.error("[ALERT] Failed:", e.message)
  }
}

async function sendEmail({ to, subject, html, text }) {
  try {
    if (!transporter) throw new Error("Email is not configured")

    await transporter.sendMail({
      from: `GBS Realty <${process.env.GMAIL_USER}>`,
      to,
      subject,
      html: html || text,
    })

    console.log(`[EMAIL] Sent: ${subject}`)
  } catch (e) {
    console.error("[EMAIL] Failed:", e.message)
  }
}

module.exports = { sendAlert, sendEmail, sendTelegram }

if (require.main === module) {
  sendAlert("GSB-100 ONLINE: System alive. Local AI running on your machine.")
    .then(() => {
      console.log("Check your alerts!")
      process.exit(0)
    })
    .catch((e) => {
      console.error(e.message)
      process.exit(1)
    })
}
