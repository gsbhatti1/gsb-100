require("dotenv").config()
const readline=require("readline")
const axios=require("axios")
const rl=readline.createInterface({input:process.stdin,output:process.stdout})
const history=[]
const SYSTEM=`You are the GSB-100 brain for GBS Realty, Salt Lake City Utah. Expert in Utah commercial and residential real estate, property management, investment analysis. Running privately on the owner's hardware — zero data leaves the building. Be direct, expert, and specific to Utah market.`
console.log("\n========================================")
console.log("  GSB-100 PRIVATE AI — DeepSeek R1 32B")
console.log("  Zero API cost. Zero data leaves PC.")
console.log("  Type 'exit' to quit")
console.log("========================================\n")
async function chat(msg){
  history.push({role:"user",content:msg})
  const prompt=`${SYSTEM}\n\n${history.map(m=>`${m.role==="user"?"Human":"Assistant"}: ${m.content}`).join("\n")}\nAssistant:`
  process.stdout.write("GSB Brain: ")
  try{
    const r=await axios.post(`${process.env.OLLAMA_HOST}/api/generate`,{model:process.env.OLLAMA_MODEL||"deepseek-r1:32b",prompt,stream:false},{timeout:180000})
    console.log(r.data.response)
    history.push({role:"assistant",content:r.data.response})
  }catch(e){console.error("\n[ERROR]",e.message)}
  rl.question("\nYou: ",async i=>{if(i.toLowerCase()==="exit"){console.log("Goodbye.");process.exit(0)};await chat(i)})
}
rl.question("You: ",async i=>await chat(i))
