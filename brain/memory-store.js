require("dotenv").config()
const path = require("path")
const fs = require("fs")
const initSqlJs = require("sql.js")
const DB_PATH = process.env.DB_PATH || "C:/gsb-100/data/brain.db"
let db = null
async function getDb() {
  if (db) return db
  const SQL = await initSqlJs()
  db = fs.existsSync(DB_PATH) ? new SQL.Database(fs.readFileSync(DB_PATH)) : new SQL.Database()
  db.run(`CREATE TABLE IF NOT EXISTS knowledge (id INTEGER PRIMARY KEY AUTOINCREMENT, topic TEXT, content TEXT, source TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS properties (id INTEGER PRIMARY KEY AUTOINCREMENT, address TEXT, type TEXT, status TEXT DEFAULT 'pending', price REAL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS buyers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, phone TEXT, email TEXT, criteria_json TEXT, active INTEGER DEFAULT 1);
    CREATE TABLE IF NOT EXISTS buyer_matches (id INTEGER PRIMARY KEY AUTOINCREMENT, buyer_id INTEGER, listing_url TEXT, platform TEXT, score INTEGER, details_json TEXT, sent INTEGER DEFAULT 0, found_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS failure_vault (id INTEGER PRIMARY KEY AUTOINCREMENT, context TEXT, what_happened TEXT, root_cause TEXT, never_do TEXT, platform TEXT, severity TEXT DEFAULT 'medium', logged_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS action_log (id INTEGER PRIMARY KEY AUTOINCREMENT, agent TEXT, action TEXT, hypothesis TEXT, outcome TEXT, success INTEGER, logged_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS ideas (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, description TEXT, why_it_matters TEXT, difficulty TEXT, first_steps TEXT, category TEXT, status TEXT DEFAULT 'new', created_at DATETIME DEFAULT CURRENT_TIMESTAMP);`)
  save(); console.log("[DB] Ready:", DB_PATH); return db
}
function save() { if (!db) return; fs.mkdirSync(path.dirname(DB_PATH),{recursive:true}); fs.writeFileSync(DB_PATH, Buffer.from(db.export())) }
function run(sql,p=[]){db.run(sql,p);save()}
function all(sql,p=[]){const s=db.prepare(sql);const r=[];s.bind(p);while(s.step())r.push(s.getAsObject());s.free();return r}
module.exports = { getDb, save,
  saveKnowledge:async(t,c,s)=>{await getDb();run("INSERT INTO knowledge(topic,content,source)VALUES(?,?,?)",[t,c,s])},
  logFailure:async(ctx,wh,rc,nd,pl)=>{await getDb();run("INSERT INTO failure_vault(context,what_happened,root_cause,never_do,platform)VALUES(?,?,?,?,?)",[ctx,wh,rc,nd,pl])},
  checkFailureVault:async(ctx)=>{await getDb();return all("SELECT * FROM failure_vault WHERE context LIKE ? OR never_do LIKE ?",[`%${ctx}%`,`%${ctx}%`])},
  logAction:async(a,ac,h)=>{await getDb();run("INSERT INTO action_log(agent,action,hypothesis)VALUES(?,?,?)",[a,ac,h])},
  getActiveBuyers:async()=>{await getDb();return all("SELECT * FROM buyers WHERE active=1")},
  saveIdea:async(ti,d,w,di,f,c)=>{await getDb();run("INSERT INTO ideas(title,description,why_it_matters,difficulty,first_steps,category)VALUES(?,?,?,?,?,?)",[ti,d,w,di,f,c])},
  getNewIdeas:async()=>{await getDb();return all("SELECT * FROM ideas WHERE status='new' ORDER BY created_at DESC")},
  addProperty:async(address,type,price)=>{await getDb();run("INSERT INTO properties(address,type,price)VALUES(?,?,?)",[address,type,price]);console.log("[DB] Property added:",address)},
  addBuyer:async(name,phone,email,criteria)=>{await getDb();run("INSERT INTO buyers(name,phone,email,criteria_json)VALUES(?,?,?,?)",[name,phone,email,JSON.stringify(criteria)]);console.log("[DB] Buyer added:",name)},
}
if(require.main===module){getDb().then(async()=>{console.log("[DB] Test PASSED");const{addProperty,addBuyer}=module.exports;await addProperty("123 Main St SLC","commercial",500000);await addBuyer("Test Buyer","+18015551234","test@test.com",{type:"commercial",maxPrice:1000000});console.log("[DB] Sample data OK");process.exit(0)}).catch(e=>{console.error(e.message);process.exit(1)})}
