require("dotenv").config()
const{getDb,saveKnowledge,logAction,addProperty}=require("../brain/memory-store")
const{checkBeforeActing,recordFailure}=require("../brain/failure-vault")
const{sendAlert}=require("../notifications/alert")
const{humanDelay}=require("../browser/playwright-config")
const axios=require("axios")
const fs=require("fs")
async function ai(prompt){try{const r=await axios.post(`${process.env.OLLAMA_HOST}/api/generate`,{model:process.env.OLLAMA_MODEL||"deepseek-r1:32b",prompt,stream:false},{timeout:120000});return r.data.response}catch(e){console.error("[AI]",e.message);return null}}
async function run(){
  console.log("\n[LISTING AGENT] Starting —",new Date().toISOString())
  const start=Date.now()
  try{
    const db=await getDb()
    const pending=db.exec("SELECT * FROM properties WHERE status='pending'")
    const rows=pending[0]?.values||[]
    const active=db.exec("SELECT * FROM properties WHERE status='active'")
    const activeRows=active[0]?.values||[]
    console.log(`[LISTING AGENT] ${rows.length} pending | ${activeRows.length} active`)
    for(const row of rows){
      const address=row[1],type=row[2],price=row[3]
      await checkBeforeActing(`listing-${type}`)
      console.log(`[LISTING AGENT] Generating AI copy for: ${address}`)
      const copy=await ai(`Write a professional MLS listing for: ${address}. Type: ${type}. Price: $${price}. Compelling, under 200 words, no markdown.`)
      if(copy){await saveKnowledge(`listing-${address}`,copy.substring(0,800),"listing-agent");db.run("UPDATE properties SET status='active' WHERE address=?",[address]);const{save}=require("../brain/memory-store");save();console.log("[LISTING AGENT] Copy generated and saved")}
      await humanDelay(2000,4000)
    }
    const dur=Math.round((Date.now()-start)/1000)
    fs.mkdirSync("logs",{recursive:true});fs.writeFileSync("logs/last-listing-run.txt",new Date().toISOString())
    const msg=`GSB-100 Listing Agent: ${rows.length} processed, ${activeRows.length} active. ${dur}s. Local AI.`
    console.log("[LISTING AGENT]",msg);await sendAlert(msg)
  }catch(err){await recordFailure({context:"listing-agent",whatHappened:err.message,rootCause:"runtime",neverDo:"check logs",platform:"all",severity:"high"});await sendAlert(`GSB-100 ALERT: Listing agent — ${err.message}`)}
}
run()
