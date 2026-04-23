require("dotenv").config()
const nodemailer=require("nodemailer")
const t=nodemailer.createTransport({service:"gmail",auth:{user:process.env.GMAIL_USER,pass:process.env.GMAIL_APP_PASSWORD}})
async function sendAlert(msg){try{await t.sendMail({from:process.env.GMAIL_USER,to:process.env.TMOBILE_GATEWAY,subject:"GSB-100",text:msg});console.log(`[ALERT] Sent: ${msg.substring(0,80)}`)}catch(e){console.error("[ALERT] Failed:",e.message)}}
async function sendEmail({to,subject,html,text}){try{await t.sendMail({from:`GBS Realty <${process.env.GMAIL_USER}>`,to,subject,html:html||text});console.log(`[EMAIL] Sent: ${subject}`)}catch(e){console.error("[EMAIL] Failed:",e.message)}}
module.exports={sendAlert,sendEmail}
if(require.main===module){sendAlert("GSB-100 ONLINE: System alive. T-Mobile gateway working. Local AI running on your machine.").then(()=>{console.log("Check your phone!");process.exit(0)}).catch(e=>{console.error(e.message);process.exit(1)})}
