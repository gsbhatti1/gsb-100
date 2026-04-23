require("dotenv").config()
const{getActiveBuyers,checkFailureVault}=require("../brain/memory-store")
const{recordFailure}=require("../brain/failure-vault")
const{sendAlert}=require("../notifications/alert")
const{humanDelay}=require("../browser/playwright-config")
const axios=require("axios")
const fs=require("fs")
async function ai(prompt){try{const r=await axios.post(`${process.env.OLLAMA_HOST}/api/generate`,{model:process.env.OLLAMA_MODEL||"deepseek-r1:32b",prompt,stream:false},{timeout:120000});return r.data.response}catch(e){return null}}
async function run(){
  console.log("\n[BUYER AGENT] Starting —",new Date().toISOString())
  try{
    const buyers=await getActiveBuyers()
    console.log(`[BUYER AGENT] ${buyers.length} active buyers`)
    for(const buyer of buyers){
      const criteria=JSON.parse(buyer.criteria_json||"{}")
      console.log(`[BUYER AGENT] Processing: ${buyer.name}`)
      const strategy=await ai(`You are a Utah real estate buyer agent. Client: ${buyer.name}. Needs: ${JSON.stringify(criteria)}. List 5 specific search strategies for LoopNet, Crexi, Utah MLS. Be specific to Utah 2026 market.`)
      if(strategy)console.log(`[BUYER AGENT] Strategy: ${strategy.substring(0,200)}...`)
      await humanDelay(3000,6000)
    }
    fs.mkdirSync("logs",{recursive:true});fs.writeFileSync("logs/last-buyer-run.txt",new Date().toISOString())
    const msg=`GSB-100 Buyer Agent: ${buyers.length} buyer(s) processed.`
    console.log("[BUYER AGENT]",msg);await sendAlert(msg)
  }catch(err){await sendAlert(`GSB-100 ALERT: Buyer agent — ${err.message}`)}
}
run()
