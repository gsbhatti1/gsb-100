require("dotenv").config()
const axios=require("axios")
async function test(){
  console.log("\n[LOCAL AI] Testing DeepSeek R1 32B — your private AI...")
  console.log("[LOCAL AI] Host:",process.env.OLLAMA_HOST)
  console.log("[LOCAL AI] Model:",process.env.OLLAMA_MODEL)
  console.log("[LOCAL AI] Asking about Utah real estate market (30-60 sec)...\n")
  try{
    const start=Date.now()
    const res=await axios.post(`${process.env.OLLAMA_HOST}/api/generate`,{model:process.env.OLLAMA_MODEL||"deepseek-r1:32b",prompt:"You are the GSB-100 real estate AI for GBS Realty in Salt Lake City Utah. In 3 sentences describe the biggest commercial real estate opportunity in Utah right now.",stream:false},{timeout:120000})
    console.log("========== YOUR PRIVATE AI SAYS ==========")
    console.log(res.data.response)
    console.log("==========================================")
    console.log(`\nTime: ${((Date.now()-start)/1000).toFixed(1)}s | Zero API cost | Zero data left your building`)
  }catch(e){console.error("[AI] FAILED:",e.message);console.log("Make sure Ollama is running: open new terminal and run: ollama serve")}
}
test()
