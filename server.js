const http = require("node:http");
const crypto = require("node:crypto");
const { Pool } = require("pg");
const SITE_ORIGIN = process.env.SITE_ORIGIN || "https://el-banko.onrender.com";
const PORT = process.env.PORT || 10000;
const TJK_HOME = "https://www.tjk.org/TR/YarisSever/Info/Page/GunlukYarisProgrami";
let cache = { until: 0, data: null };
const db = process.env.DATABASE_URL ? new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}}) : null;
let dbReady = false;
async function initMembers(){if(!db)return;await db.query("CREATE TABLE IF NOT EXISTS members (id BIGSERIAL PRIMARY KEY, full_name VARCHAR(100) NOT NULL, username VARCHAR(30) UNIQUE NOT NULL, email VARCHAR(254) UNIQUE NOT NULL, phone VARCHAR(25), password_hash TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), status VARCHAR(20) NOT NULL DEFAULT 'pending')");dbReady=true;console.log("EL BANKO member table ready");}
function jsonBody(req){return new Promise((resolve,reject)=>{let data="";req.on("data",c=>{data+=c;if(data.length>10000)reject(new Error("Form çok büyük"));});req.on("end",()=>{try{resolve(JSON.parse(data||"{}"));}catch{reject(new Error("Form bilgileri okunamadı"));}});req.on("error",reject);});}
function hashPassword(password){return new Promise((resolve,reject)=>{const salt=crypto.randomBytes(16);crypto.scrypt(password,salt,64,(err,key)=>err?reject(err):resolve(salt.toString("hex")+":"+key.toString("hex")));});}

function send(res,status,data){
  res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Access-Control-Allow-Origin":SITE_ORIGIN,"Access-Control-Allow-Methods":"GET, POST, OPTIONS","Access-Control-Allow-Headers":"Content-Type, Authorization","Cache-Control":"no-store","Vary":"Origin"});
  res.end(JSON.stringify(data));
}
function cleanText(s){
  return String(s||"").replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi," ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi," ").replace(/<!--[\s\S]*?-->/g," ").replace(/<[^>]+>/g," ").replace(/&nbsp;|&#160;/gi," ").replace(/&amp;/gi,"&").replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'").replace(/&lt;/gi,"<").replace(/&gt;/gi,">").replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n))).replace(/\s+/g," ").trim();
}
async function getHtml(url){
  const r=await fetch(url,{headers:{"User-Agent":"EL-BANKO daily race program reader/1.0","Accept":"text/html,application/xhtml+xml"},signal:AbortSignal.timeout(16000)});
  if(!r.ok) throw new Error("TJK yanıtı: HTTP "+r.status);
  return await r.text();
}
function parseCourse(html,label,url){
  const races=[];
  const headingRe=/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi;
  let hm;
  while((hm=headingRe.exec(html))){
    const title=cleanText(hm[1]);
    const m=title.match(/(\d+)\.?\s*Koşu\s*([0-2]?\d[.:][0-5]\d)/i);
    if(m) races.push({number:Number(m[1]),time:m[2].replace(".",":"),title});
  }
  const horses=[];
  const trRe=/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let tm;
  while((tm=trRe.exec(html))){
    const row=tm[1];
    const cells=[];
    const tdRe=/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let td;
    while((td=tdRe.exec(row))) cells.push(cleanText(td[1]));
    if(cells.length<8) continue;
    const linkRe=/<a\b[^>]*>([\s\S]*?)<\/a>/gi;
    let lm, horse="";
    while((lm=linkRe.exec(row))){
      const name=cleanText(lm[1]).replace(/\s*\(\d+\)\s*$/,"").trim();
      if(name && !/^(PDF Program|Özet PDF Program|CSV Program|Resmi Program|Detaylı At Karşılaştırma|Bu derece|Image|Koşu Bilgisi|At Karşılaştırma|Jokey Karşılaştırma)$/i.test(name) && name.length>1 && !/Koşu$/.test(name)){horse=name;break;}
    }
    if(!horse || /^(Forma|At İsmi|Jokey|Antrenör|Sahip)$/.test(horse)) continue;
    if(horses.some(h=>h.name===horse)) continue;
    const numberCell=cells.find(c=>/^\d{1,2}$/.test(c));
    horses.push({number:numberCell||"",name:horse,details:cells.slice(0,18)});
    if(horses.length>=300) break;
  }
  return {course:label||"Hipodrom",url,races,horseCount:horses.length,horses,updatedAt:new Date().toISOString()};
}
async function getDailyRaces(){
  const home=await getHtml(TJK_HOME);
  const links=[];
  const aRe=/<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while((m=aRe.exec(home))){
    const href=(m[1].match(/href\s*=\s*["']([^"']+)["']/i)||[])[1];
    const label=cleanText(m[2]);
    if(!href || !label || !href.includes("/TR/YarisSever/Info/Sehir/GunlukYarisProgrami")) continue;
    const url=new URL(href,TJK_HOME).toString();
    if(!links.some(x=>x.url===url)) links.push({label,url});
  }
  if(!links.length) throw new Error("TJK günlük program sayfasında hipodrom bağlantıları bulunamadı.");
  const results=[];
  for(let i=0;i<Math.min(links.length,10);i+=3){
    const batch=links.slice(i,i+3);
    const got=await Promise.all(batch.map(async item=>{
      try { return parseCourse(await getHtml(item.url),item.label,item.url); }
      catch(e){ return {course:item.label,url:item.url,races:[],horses:[],horseCount:0,error:"Bu hipodromun verisi şu anda alınamadı."}; }
    }));
    results.push(...got);
  }
  const courses=results.filter(x=>x.races.length||x.horseCount>0);
  if(!courses.length) throw new Error("TJK sayfası ulaşıldı ancak yarış tablosu ayrıştırılamadı.");
  return {source:"Türkiye Jokey Kulübü (TJK)",fetchedAt:new Date().toISOString(),courses,notice:"Resmî programdan alınan veriler bilgilendirme ve performans karşılaştırması içindir. Yarış sonuçları garanti edilemez."};
}
const adminSessions=new Map();
function safeEqual(a,b){
  const aa=Buffer.from(String(a||""));const bb=Buffer.from(String(b||""));
  return aa.length===bb.length && aa.length>0 && crypto.timingSafeEqual(aa,bb);
}
function adminAuthorized(req){
  const token=String(req.headers.authorization||"").replace(/^Bearer\\s+/i,"");
  const expiry=adminSessions.get(token);
  if(!token||!expiry||expiry<Date.now()){adminSessions.delete(token);return false;}
  return true;
}
const server=http.createServer(async(req,res)=>{
  if(req.method==="OPTIONS"){res.writeHead(204,{"Access-Control-Allow-Origin":SITE_ORIGIN,"Access-Control-Allow-Methods":"GET, OPTIONS"});return res.end();}
  const url=new URL(req.url,"http://localhost");
  if(url.pathname==="/health") return send(res,200,{ok:true,service:"EL BANKO race data",membersDatabase:dbReady?"connected":"not_configured",time:new Date().toISOString()});
  if(url.pathname==="/api/admin/login" && req.method==="POST"){
    if(!process.env.ADMIN_PASSWORD)return send(res,503,{error:"Yönetici şifresi sunucuda ayarlanmamış."});
    let b;try{b=await jsonBody(req);}catch(e){return send(res,400,{error:e.message});}
    if(!safeEqual(b.password,process.env.ADMIN_PASSWORD))return send(res,401,{error:"Yönetici şifresi hatalı."});
    const token=crypto.randomBytes(32).toString("hex");
    adminSessions.set(token,Date.now()+8*60*60*1000);
    return send(res,200,{ok:true,token,expiresIn:28800});
  }
  if(url.pathname==="/api/admin/logout" && req.method==="POST"){
    const token=String(req.headers.authorization||"").replace(/^Bearer\\s+/i,"");
    adminSessions.delete(token);return send(res,200,{ok:true});
  }
  if(url.pathname==="/api/admin/members" && req.method==="GET"){
    if(!adminAuthorized(req))return send(res,401,{error:"Yönetici oturumu geçersiz veya süresi dolmuş."});
    if(!db||!dbReady)return send(res,503,{error:"Üyelik veri tabanı bağlı değil."});
    try{const r=await db.query("SELECT id,full_name,username,email,phone,status,created_at FROM members ORDER BY created_at DESC LIMIT 500");return send(res,200,{members:r.rows});}
    catch(e){console.error("Admin member list failed",e.message);return send(res,500,{error:"Üye listesi alınamadı."});}
  }
  if(url.pathname.startsWith("/api/admin/members/") && url.pathname.endsWith("/status") && req.method==="POST"){
    if(!adminAuthorized(req))return send(res,401,{error:"Yönetici oturumu geçersiz veya süresi dolmuş."});
    if(!db||!dbReady)return send(res,503,{error:"Üyelik veri tabanı bağlı değil."});
    const id=url.pathname.split("/")[4];if(!/^\\d+$/.test(id))return send(res,400,{error:"Üye numarası geçersiz."});
    let b;try{b=await jsonBody(req);}catch(e){return send(res,400,{error:e.message});}
    if(!["pending","approved","rejected","suspended"].includes(b.status))return send(res,400,{error:"Durum seçimi geçersiz."});
    try{const r=await db.query("UPDATE members SET status=$1 WHERE id=$2 RETURNING id,full_name,username,email,status,created_at",[b.status,id]);if(!r.rowCount)return send(res,404,{error:"Üye bulunamadı."});return send(res,200,{ok:true,member:r.rows[0]});}
    catch(e){console.error("Admin member update failed",e.message);return send(res,500,{error:"Üye durumu güncellenemedi."});}
  }
  if(url.pathname==="/api/members" && req.method==="POST"){
    if(!db || !dbReady)return send(res,503,{error:"Üyelik veri tabanı henüz bağlanmadı."});
    if(req.headers.origin && req.headers.origin!==SITE_ORIGIN)return send(res,403,{error:"İstek kaynağı kabul edilmedi."});
    let b;try{b=await jsonBody(req);}catch(e){return send(res,400,{error:e.message});}
    const name=String(b.name||"").trim(),username=String(b.username||"").trim(),email=String(b.email||"").trim().toLowerCase(),phone=String(b.phone||"").trim(),password=String(b.password||"");
    if(name.length<2||name.length>100)return send(res,400,{error:"Ad soyad bilgisi geçersiz."});
    if(!/^[A-Za-z0-9._-]{3,30}$/.test(username))return send(res,400,{error:"Kullanıcı adı 3-30 karakter olmalı."});
    if(!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email))return send(res,400,{error:"Geçerli e-posta girin."});
    if(password.length<10||password.length>128)return send(res,400,{error:"Şifre en az 10 karakter olmalı."});
    if(b.termsAccepted!==true)return send(res,400,{error:"Üyelik koşullarını kabul etmelisiniz."});
    try{const hash=await hashPassword(password);const r=await db.query("INSERT INTO members(full_name,username,email,phone,password_hash) VALUES($1,$2,$3,$4,$5) RETURNING id,full_name,username,email,status,created_at",[name,username,email,phone||null,hash]);return send(res,201,{ok:true,message:"Üyelik başvurunuz kaydedildi. Yönetici onayından sonra hesabınız etkinleştirilecektir.",member:r.rows[0]});}
    catch(e){if(e.code==="23505")return send(res,409,{error:"Bu kullanıcı adı veya e-posta zaten kayıtlı."});console.error("Member registration failed",e.message);return send(res,500,{error:"Kayıt tamamlanamadı. Lütfen daha sonra deneyin."});}
  }
  if(url.pathname==="/api/races" && req.method==="GET"){
    if(cache.data && cache.until>Date.now()) return send(res,200,{...cache.data,cached:true});
    try{const data=await getDailyRaces();cache={data,until:Date.now()+5*60*1000};return send(res,200,{...data,cached:false});}
    catch(e){return send(res,502,{error:"Günlük yarış verisi şu anda resmî kaynaktan alınamadı.",detail:String(e.message||e),source:"TJK",checkedAt:new Date().toISOString()});}
  }
  return send(res,404,{error:"Bulunamadı"});
});
server.listen(PORT,"0.0.0.0",()=>{console.log("EL BANKO race API running on "+PORT);initMembers().catch(e=>console.error("Member DB setup failed:",e.message));});
