require("dotenv").config()
const{chromium}=require("playwright")
const humanDelay=(min=2000,max=7000)=>new Promise(r=>setTimeout(r,Math.floor(Math.random()*(max-min)+min)))
async function humanType(page,selector,text){await page.click(selector);for(const c of text)await page.type(selector,c,{delay:Math.floor(Math.random()*130+50)})}
async function humanScroll(page){await page.evaluate(()=>window.scrollBy(0,Math.floor(Math.random()*300+100)));await humanDelay(800,2000)}
async function launchBrowser(){const browser=await chromium.launch({headless:false,args:["--disable-blink-features=AutomationControlled"]});const context=await browser.newContext({userAgent:"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"});const page=await context.newPage();await page.addInitScript(()=>Object.defineProperty(navigator,"webdriver",{get:()=>undefined}));return{browser,context,page,humanDelay,humanType,humanScroll}}
module.exports={launchBrowser,humanDelay,humanType,humanScroll}
