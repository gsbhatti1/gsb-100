require("dotenv").config()
const {logFailure,checkFailureVault}=require("./memory-store")
const {sendAlert}=require("../notifications/alert")
async function checkBeforeActing(context){const past=await checkFailureVault(context);if(past.length>0){console.log(`[VAULT] WARNING: ${past.length} past failures for "${context}"`);past.forEach(f=>console.log(`  - ${f.what_happened} | NEVER DO: ${f.never_do}`))}return past}
async function recordFailure({context,whatHappened,rootCause,neverDo,platform,severity="medium"}){await logFailure(context,whatHappened,rootCause,neverDo,platform);console.log(`[VAULT] Logged: ${context}`);if(severity==="critical")await sendAlert(`GSB-100 CRITICAL: ${context} — ${whatHappened}`)}
module.exports={checkBeforeActing,recordFailure}
