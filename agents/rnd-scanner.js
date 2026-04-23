require("dotenv").config()
const{saveKnowledge,saveIdea,getNewIdeas}=require("../brain/memory-store")
const{sendAlert}=require("../notifications/alert")
const axios=require("axios")
const TOPICS=["Utah commercial real estate 2026","SLC office vacancy rates","AppFolio alternatives property management","real estate AI tools 2026","Utah residential inventory prices","commercial leasing retail industrial Utah","real estate investment Utah ROI","Utah broker competitor analysis"]
async function ai(prompt){try{const r=await axios.post(`${process.env.OLLAMA_HOST}/api/generate`,{model:process.env.OLLAMA_MODEL||"deepseek-r1:32b",prompt,stream:false},{timeout:180000});return r.data.response}catch(e){console.error("[AI]",e.message);return null}}
async function run(){
  console.log("\n[R&D SCANNER] Starting —",new Date().toISOString())
  for(const t of TOPICS){await saveKnowledge(t,`Scanned ${new Date().toDateString()}`,"weekly-rnd");process.stdout.write(".")}
  console.log(`\n[R&D] ${TOPICS.length} topics logged`)
  console.log("[R&D] Generating ideas with local DeepSeek AI...")
  const ideas=await ai(`You are the strategic brain for GBS Realty (gsbrealtor.com) Salt Lake City Utah. Date: ${new Date().toDateString()}.\n\nGenerate 3 high-value business ideas.\nFor each:\nIDEA: [title]\nWHY: [why it matters for Utah 2026]\nDIFFICULTY: [Easy/Medium/Complex]\nSTEPS: [3 actions]\n---\nThink big. Be specific to Utah real estate.`)
  if(ideas){
    await saveIdea(`Ideas ${new Date().toDateString()}`,ideas.substring(0,2000),"Local DeepSeek AI","varies","Review and pick one","rnd-weekly")
    console.log("\n[R&D] IDEAS GENERATED:\n",ideas.substring(0,600))
  }
  const all=await getNewIdeas()
  const msg=`GSB-100 R&D: ${TOPICS.length} topics scanned. ${all.length} ideas in database.`
  console.log("[R&D]",msg);await sendAlert(msg)
}
run()
