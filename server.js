const http = require("node:http");
const crypto = require("node:crypto");
const { Pool } = require("pg");
const SITE_ORIGIN = process.env.SITE_ORIGIN || "https://el-banko.onrender.com";
const PORT = process.env.PORT || 10000;
const TJK_HOME = "https://www.tjk.org/TR/YarisSever/Info/Page/GunlukYarisProgrami";
let cache = { until: 0, data: null };
let refreshPromise = null;
const db = process.env.DATABASE_URL ? new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}}) : null;
let dbReady = false;
async function initMembers(){
 if(!db)return;
 await db.query("CREATE TABLE IF NOT EXISTS members (id BIGSERIAL PRIMARY KEY, full_name VARCHAR(100) NOT NULL, username VARCHAR(30) UNIQUE NOT NULL, email VARCHAR(254) UNIQUE NOT NULL, phone VARCHAR(25), password_hash TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), status VARCHAR(20) NOT NULL DEFAULT 'pending')");
 await db.query("CREATE TABLE IF NOT EXISTS member_sessions (token_hash CHAR(64) PRIMARY KEY, member_id BIGINT NOT NULL REFERENCES members(id) ON DELETE CASCADE, expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
 await db.query("CREATE TABLE IF NOT EXISTS member_wallets (member_id BIGINT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE, balance BIGINT NOT NULL DEFAULT 0 CHECK(balance >= 0), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
 await db.query("CREATE TABLE IF NOT EXISTS wallet_transactions (id BIGSERIAL PRIMARY KEY, member_id BIGINT NOT NULL REFERENCES members(id) ON DELETE CASCADE, amount BIGINT NOT NULL, balance_after BIGINT NOT NULL, kind VARCHAR(30) NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'pending', reference VARCHAR(120), description VARCHAR(250) NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(kind, reference))");
 await db.query("CREATE TABLE IF NOT EXISTS payment_orders (id BIGSERIAL PRIMARY KEY, member_id BIGINT NOT NULL REFERENCES members(id) ON DELETE CASCADE, provider VARCHAR(20) NOT NULL DEFAULT 'bank_transfer', package_tokens BIGINT NOT NULL CHECK(package_tokens IN (200,500,1000,2500,5000)), amount_kurus BIGINT NOT NULL CHECK(amount_kurus > 0), status VARCHAR(20) NOT NULL DEFAULT 'pending', provider_reference VARCHAR(160), transfer_note VARCHAR(160), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), paid_at TIMESTAMPTZ, approved_by VARCHAR(100))");
 await db.query("ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS payment_note TEXT");
 await db.query("ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ");
 await db.query("ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS transfer_note VARCHAR(160)");
 await db.query("ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS approved_by VARCHAR(100)");
 await db.query("ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS payment_note VARCHAR(500)");
 await db.query("ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ");
 await db.query("ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ");
 await db.query("ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS reviewed_by VARCHAR(100)");
 await db.query("ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS payment_note VARCHAR(500)");
 await db.query("ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ");
 await db.query("ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ");
 await db.query("ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS reviewed_by VARCHAR(100)");
 await db.query("CREATE TABLE IF NOT EXISTS coupon_drafts (id BIGSERIAL PRIMARY KEY, member_id BIGINT NOT NULL REFERENCES members(id) ON DELETE CASCADE, title VARCHAR(120) NOT NULL, content TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
 await db.query("INSERT INTO member_wallets(member_id,balance) SELECT id,0 FROM members ON CONFLICT(member_id) DO NOTHING");
 await db.query("DELETE FROM member_sessions WHERE expires_at < NOW()");
 dbReady=true;console.log("EL BANKO member, wallet, transaction and coupon tables ready");
}
function tokenHash(token){return crypto.createHash("sha256").update(String(token||"")).digest("hex");}
async function authenticatedMember(req){
 if(!db||!dbReady)return null;
 const token=String(req.headers.authorization||"").replace(/^Bearer\s+/i,"").trim();
 if(!/^[a-f0-9]{64}$/i.test(token))return null;
 const r=await db.query("SELECT m.id,m.full_name,m.username,m.email,m.phone,m.status FROM member_sessions s JOIN members m ON m.id=s.member_id WHERE s.token_hash=$1 AND s.expires_at>NOW()",[tokenHash(token)]);
 return r.rows[0]||null;
}
function jsonBody(req){return new Promise((resolve,reject)=>{let data="";req.on("data",c=>{data+=c;if(data.length>10000)reject(new Error("Form çok büyük"));});req.on("end",()=>{try{resolve(JSON.parse(data||"{}"));}catch{reject(new Error("Form bilgileri okunamadı"));}});req.on("error",reject);});}
function hashPassword(password){return new Promise((resolve,reject)=>{const salt=crypto.randomBytes(16);crypto.scrypt(password,salt,64,(err,key)=>err?reject(err):resolve(salt.toString("hex")+":"+key.toString("hex")));});}

function send(res,status,data){
  res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Access-Control-Allow-Origin":SITE_ORIGIN,"Access-Control-Allow-Methods":"GET, POST, OPTIONS","Access-Control-Allow-Headers":"Content-Type, Authorization, X-Admin-Key","Cache-Control":"no-store","Vary":"Origin"});
  res.end(JSON.stringify(data));
}
function cleanText(s){
  return String(s||"").replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi," ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi," ").replace(/<!--[\s\S]*?-->/g," ").replace(/<[^>]+>/g," ").replace(/&nbsp;|&#160;/gi," ").replace(/&amp;/gi,"&").replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'").replace(/&lt;/gi,"<").replace(/&gt;/gi,">").replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n))).replace(/\s+/g," ").trim();
}
async function getHtml(url,referer=TJK_HOME){
  const r=await fetch(url,{headers:{
    "User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Accept":"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language":"tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
    "Referer":referer,
    "Cache-Control":"no-cache"
  },signal:AbortSignal.timeout(30000)});
  if(!r.ok) throw new Error("Resmî yarış verisi HTTP "+r.status);
  return await r.text();
}
function parseHorses(html){
  const horses=[];
  const trRe=/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let tm;
  while((tm=trRe.exec(html))){
    const row=tm[1],cells=[];
    const tdRe=/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let td;while((td=tdRe.exec(row)))cells.push(cleanText(td[1]));
    if(cells.length<8)continue;
    const linkRe=/<a\b[^>]*>([\s\S]*?)<\/a>/gi;
    let lm,horse="";
    while((lm=linkRe.exec(row))){
      const name=cleanText(lm[1]).replace(/\s*\(\d+\)\s*$/,"").trim();
      if(name&&!/^(PDF Program|Özet PDF Program|CSV Program|Resmi Program|Detaylı At Karşılaştırma|Bu derece|Image|Koşu Bilgisi|At Karşılaştırma|Jokey Karşılaştırma|Sahip Karşılaştırma|Antrenör Karşılaştırma|İdman Bilgileri)$/i.test(name)&&name.length>1&&!/Koşu$/.test(name)){horse=name;break;}
    }
    if(!horse||/^(Forma|At İsmi|Jokey|Antrenör|Sahip)$/.test(horse)||horses.some(h=>h.name===horse))continue;
    const numberCell=cells.find((v,i)=>i<4&&/^\d{1,2}$/.test(v))||"";
    horses.push({number:numberCell,name:horse,details:cells.slice(0,18)});
    if(horses.length>=100)break;
  }
  return horses;
}
function parseCourse(html,label,url){
  const headings=[];
  const headingRe=/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi;
  let hm;
  while((hm=headingRe.exec(html))){
    const title=cleanText(hm[1]);
    const m=title.match(/(\d+)\.?\s*Koşu\s*([0-2]?\d[.:][0-5]\d)/i);
    if(m)headings.push({number:Number(m[1]),time:m[2].replace(".",":"),title,offset:hm.index,end:headingRe.lastIndex});
  }
  const racesByNumber=new Map();
  for(let i=0;i<headings.length;i++){
    const h=headings[i],next=headings[i+1];
    const segment=html.slice(h.end,next?next.offset:Math.min(html.length,h.end+350000));
    const horses=parseHorses(segment);
    if(!horses.length)continue;
    if(!racesByNumber.has(h.number))racesByNumber.set(h.number,{number:h.number,time:h.time,title:h.title,horses});
  }
  const races=[...racesByNumber.values()].sort((a,b)=>a.number-b.number);
  const allHorses=[];
  for(const race of races)for(const horse of race.horses)if(!allHorses.some(h=>h.name===horse.name))allHorses.push(horse);
  return {course:label||"Hipodrom",url,races,horseCount:allHorses.length,horses:allHorses,updatedAt:new Date().toISOString()};
}
function parseFallbackCourse(html,label,url){
  const headingRe=/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi;
  const headings=[];
  let hm;
  while((hm=headingRe.exec(html))){
    const title=cleanText(hm[1]);
    const m=title.match(/^(\d+)\.?\s*Koşu\b/i);
    if(m)headings.push({number:Number(m[1]),title,offset:hm.index,end:headingRe.lastIndex});
  }
  const races=[];
  for(let i=0;i<headings.length;i++){
    const h=headings[i],next=headings[i+1];
    const segment=html.slice(h.end,next?next.offset:Math.min(html.length,h.end+100000));
    const text=cleanText(segment);
    const tm=text.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
    const dm=text.match(/\b(\d{3,4})\s*m\b/i);
    const surface=(text.match(/\b(Kum|Sentetik|Çim)\b/i)||[])[1]||"";
    const horses=[];
    const liRe=/<li\b[^>]*>([\s\S]*?)<\/li>/gi;
    let lm;
    while((lm=liRe.exec(segment))){
      const row=cleanText(lm[1]);
      const hm2=row.match(/^(\d{1,2})\s+(.+?)\s*$/);
      if(!hm2)continue;
      const name=hm2[2].replace(/\s+(GanyanMetrik favorileri:.*)$/i,"").trim();
      if(!name||name.length<2||/^(Günlük bülten|Altılı kupon|Model sıralaması|Ücretsiz üyelik)/i.test(name))continue;
      if(!horses.some(x=>x.name===name))horses.push({number:hm2[1],name,details:[hm2[1],name]});
    }
    if(horses.length)races.push({number:h.number,time:tm?tm[0]:"",title:h.title+(dm?" · "+dm[1]+" m":"")+(surface?" · "+surface:""),horses});
  }
  const allHorses=[];
  for(const race of races)for(const horse of race.horses)if(!allHorses.some(h=>h.name===horse.name))allHorses.push(horse);
  return {course:label,url,races,horseCount:allHorses.length,horses:allHorses,updatedAt:new Date().toISOString()};
}
async function getFallbackRaces(){
  const parts=new Intl.DateTimeFormat("en-GB",{timeZone:"Europe/Istanbul",day:"2-digit",month:"2-digit",year:"numeric"}).formatToParts(new Date());
  const p=Object.fromEntries(parts.map(x=>[x.type,x.value]));
  const date=p.year+"-"+p.month+"-"+p.day;
  const targets=[{name:"Adana",url:"https://www.ganyanmetrik.com/y/adana/"+date},{name:"Kocaeli",url:"https://www.ganyanmetrik.com/y/kocaeli/"+date}];
  const results=await Promise.all(targets.map(async target=>{
    try{return parseFallbackCourse(await getHtml(target.url,"https://www.ganyanmetrik.com/"),target.name,target.url);}
    catch(e){console.error("EL BANKO fallback race fetch failed",target.name,e.message);return null;}
  }));
  const courses=results.filter(x=>x&&x.races.length&&x.horseCount>0);
  if(!courses.length)throw new Error("Resmî yarış sayfaları yanıt vermedi ve yedek yarış verisi de alınamadı.");
  return {source:"EL BANKO",fetchedAt:new Date().toISOString(),courses,notice:"Yarış verileri bilgilendirme amaçlıdır; sonuç veya kazanç garantisi değildir."};
}
async function getDailyRaces(){
  let sourceError=null;
  try{
    const home=await getHtml(TJK_HOME);
    const links=[];
    const aRe=/<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
    let m;
    while((m=aRe.exec(home))){
      const href=(m[1].match(/href\s*=\s*["']([^"']+)["']/i)||[])[1];
      const label=cleanText(m[2]);
      if(!href||!label||!decodeURIComponent(href).toLowerCase().includes("/tr/yarissever/info/sehir/gunlukyarisprogrami"))continue;
      if(/\bYD\s*\d+/i.test(label)||/Karma/i.test(label))continue;
      if(!/(Adana|Kocaeli|İstanbul|Istanbul|Ankara|İzmir|Izmir|Bursa|Antalya|Elazığ|Elazig|Diyarbakır|Diyarbakir|Şanlıurfa|Sanliurfa|Gaziantep|Konya|Kayseri|Eskişehir|Eskisehir|Mersin|Sivas|Trabzon)/i.test(label))continue;
      const url=new URL(href,TJK_HOME).toString();
      if(!links.some(x=>x.url===url))links.push({label,url});
    }
    const results=await Promise.all(links.slice(0,6).map(async item=>{
      try{return parseCourse(await getHtml(item.url),item.label,item.url);}
      catch(e){console.error("EL BANKO course fetch failed",item.label,e.message);return null;}
    }));
    const courses=results.filter(x=>x&&(x.races.length||x.horseCount>0));
    if(courses.length)return {source:"EL BANKO",fetchedAt:new Date().toISOString(),courses,notice:"Resmî programdan alınan veriler bilgilendirme ve performans karşılaştırması içindir. Yarış sonuçları garanti edilemez."};
    sourceError=new Error("Resmî yarış sayfaları ulaşılamadı veya yarış tablosu ayrıştırılamadı.");
  }catch(e){sourceError=e;}
  console.error("EL BANKO official race source unavailable:",sourceError&&sourceError.message);
  return await getFallbackRaces();
}
const adminSessions=new Map();
function safeEqual(a,b){
  const aa=Buffer.from(String(a||""));const bb=Buffer.from(String(b||""));
  return aa.length===bb.length && aa.length>0 && crypto.timingSafeEqual(aa,bb);
}
function adminAuthorized(req){
  const token=String(req.headers.authorization||"").split(" ").pop();
  const expiry=adminSessions.get(token);
  if(!token||!expiry||expiry<Date.now()){adminSessions.delete(token);return false;}
  return true;
}
const server=http.createServer(async(req,res)=>{
  if(req.method==="OPTIONS"){res.writeHead(204,{"Access-Control-Allow-Origin":SITE_ORIGIN,"Access-Control-Allow-Methods":"GET, POST, OPTIONS","Access-Control-Allow-Headers":"Content-Type, Authorization"});return res.end();}
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
    const token=String(req.headers.authorization||"").split(" ").pop();
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
    const id=url.pathname.split("/")[4];if(!Number.isSafeInteger(Number(id))||Number(id)<1)return send(res,400,{error:"Üye numarası geçersiz."});
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
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return send(res,400,{error:"Geçerli e-posta girin."});
    if(password.length<10||password.length>128)return send(res,400,{error:"Şifre en az 10 karakter olmalı."});
    if(b.termsAccepted!==true)return send(res,400,{error:"Üyelik koşullarını kabul etmelisiniz."});
    try{const hash=await hashPassword(password);const r=await db.query("INSERT INTO members(full_name,username,email,phone,password_hash) VALUES($1,$2,$3,$4,$5) RETURNING id,full_name,username,email,status,created_at",[name,username,email,phone||null,hash]);return send(res,201,{ok:true,message:"Üyelik başvurunuz kaydedildi. Yönetici onayından sonra hesabınız etkinleştirilecektir.",member:r.rows[0]});}
    catch(e){if(e.code==="23505")return send(res,409,{error:"Bu kullanıcı adı veya e-posta zaten kayıtlı."});console.error("Member registration failed",e.message);return send(res,500,{error:"Kayıt tamamlanamadı. Lütfen daha sonra deneyin."});}
  }
  if(url.pathname==="/api/members/login" && req.method==="POST"){
    if(!db||!dbReady)return send(res,503,{error:"Üyelik veri tabanı henüz bağlanmadı."});
    let b;try{b=await jsonBody(req);}catch(e){return send(res,400,{error:e.message});}
    const identity=String(b.identity||"").trim().toLowerCase(),password=String(b.password||"");
    if(!identity||!password)return send(res,400,{error:"Kullanıcı adı/e-posta ve şifre girin."});
    try{
      const r=await db.query("SELECT id,full_name,username,email,phone,password_hash,status FROM members WHERE lower(username)=lower($1) OR lower(email)=lower($1) LIMIT 1",[identity]);
      const m=r.rows[0];if(!m)return send(res,401,{error:"Giriş bilgileri hatalı."});
      const [saltHex,keyHex]=m.password_hash.split(":");
      const candidate=await new Promise((resolve,reject)=>crypto.scrypt(password,Buffer.from(saltHex,"hex"),64,(err,key)=>err?reject(err):resolve(key.toString("hex"))));
      if(!safeEqual(candidate,keyHex))return send(res,401,{error:"Giriş bilgileri hatalı."});
      if(m.status!=="approved")return send(res,403,{error:m.status==="suspended"?"Hesabınız askıya alınmış.":"Hesabınız yönetici onayını bekliyor."});
      const token=crypto.randomBytes(32).toString("hex");
      await db.query("INSERT INTO member_sessions(token_hash,member_id,expires_at) VALUES($1,$2,NOW()+INTERVAL '7 days')",[tokenHash(token),m.id]);
      await db.query("INSERT INTO member_wallets(member_id,balance) VALUES($1,0) ON CONFLICT(member_id) DO NOTHING",[m.id]);
      return send(res,200,{ok:true,token,member:{id:m.id,name:m.full_name,username:m.username,email:m.email},expiresIn:604800});
    }catch(e){console.error("Member login failed",e.message);return send(res,500,{error:"Giriş yapılamadı. Lütfen tekrar deneyin."});}
  }
  if(url.pathname==="/api/members/logout" && req.method==="POST"){
    if(db&&dbReady){const token=String(req.headers.authorization||"").replace(/^Bearer\s+/i,"").trim();if(token)await db.query("DELETE FROM member_sessions WHERE token_hash=$1",[tokenHash(token)]).catch(()=>{});}
    return send(res,200,{ok:true});
  }
  if(url.pathname==="/api/account" && req.method==="GET"){
    const m=await authenticatedMember(req);if(!m)return send(res,401,{error:"Devam etmek için onaylı üye hesabınızla giriş yapın."});
    try{const w=await db.query("SELECT balance FROM member_wallets WHERE member_id=$1",[m.id]);return send(res,200,{member:{id:m.id,name:m.full_name,username:m.username,email:m.email,phone:m.phone},wallet:{balance:Number(w.rows[0]?.balance||0)},payment:{enabled:false,reason:"PayTR/iyzico tercihi, işyeri başvurusu ve güvenli anahtarlar henüz yapılandırılmadı."}});}
    catch(e){console.error("Account read failed",e.message);return send(res,500,{error:"Hesap bilgileri alınamadı."});}
  }
  if(url.pathname==="/api/account/transactions" && req.method==="GET"){
    const m=await authenticatedMember(req);if(!m)return send(res,401,{error:"Giriş yapmanız gerekiyor."});
    try{const r=await db.query("SELECT id,amount,balance_after,kind,status,reference,description,created_at FROM wallet_transactions WHERE member_id=$1 ORDER BY created_at DESC LIMIT 100",[m.id]);return send(res,200,{transactions:r.rows});}
    catch(e){console.error("Wallet history failed",e.message);return send(res,500,{error:"İşlem geçmişi alınamadı."});}
  }
  if(url.pathname==="/api/coupon-drafts" && req.method==="GET"){
    const m=await authenticatedMember(req);if(!m)return send(res,401,{error:"Kupon taslaklarını kaydetmek için giriş yapın."});
    try{const r=await db.query("SELECT id,title,content,created_at,updated_at FROM coupon_drafts WHERE member_id=$1 ORDER BY updated_at DESC LIMIT 50",[m.id]);return send(res,200,{drafts:r.rows});}
    catch(e){console.error("Coupon drafts read failed",e.message);return send(res,500,{error:"Kupon taslakları alınamadı."});}
  }
  if(url.pathname==="/api/coupon-drafts" && req.method==="POST"){
    const m=await authenticatedMember(req);if(!m)return send(res,401,{error:"Kupon taslağını kaydetmek için giriş yapın."});
    let b;try{b=await jsonBody(req);}catch(e){return send(res,400,{error:e.message});}
    const title=String(b.title||"Kupon taslağı").trim().slice(0,120),content=String(b.content||"").trim();
    if(!content||content.length>12000)return send(res,400,{error:"Kupon taslağı boş olamaz ve 12.000 karakteri aşamaz."});
    try{const r=await db.query("INSERT INTO coupon_drafts(member_id,title,content) VALUES($1,$2,$3) RETURNING id,title,content,created_at,updated_at",[m.id,title||"Kupon taslağı",content]);return send(res,201,{ok:true,draft:r.rows[0],message:"Kupon taslağı hesabınıza kaydedildi. Gerçek bahis gönderilmedi."});}
    catch(e){console.error("Coupon draft save failed",e.message);return send(res,500,{error:"Kupon taslağı kaydedilemedi."});}
  }
  if(url.pathname==="/api/payments/info" && req.method==="GET"){
    const prices={};
    for(const n of [200,500,1000,2500,5000]){const v=Number(process.env["TOKEN_PRICE_"+n+"_KURUS"]||0);prices[n]=Number.isSafeInteger(v)&&v>0?v:null;}
    return send(res,200,{iban:process.env.ELBANKO_PAYMENT_IBAN||"",bank:process.env.ELBANKO_PAYMENT_BANK||"",accountHolder:process.env.ELBANKO_PAYMENT_HOLDER||"",prices,ready:Boolean(process.env.ELBANKO_PAYMENT_IBAN&&process.env.ELBANKO_PAYMENT_HOLDER&&[200,500,1000,2500,5000].every(n=>prices[n]))});
  }
  if(url.pathname==="/api/payments/orders" && req.method==="GET"){
    const m=await authenticatedMember(req);if(!m)return send(res,401,{error:"Ödeme taleplerini görmek için giriş yapın."});
    try{const r=await db.query("SELECT id,package_tokens,amount_kurus,status,provider_reference,payment_note,created_at,submitted_at,reviewed_at FROM payment_orders WHERE member_id=$1 ORDER BY created_at DESC LIMIT 50",[m.id]);return send(res,200,{orders:r.rows});}
    catch(e){console.error("Payment orders read failed",e.message);return send(res,500,{error:"Ödeme talepleri alınamadı."});}
  }
  if(url.pathname==="/api/payments/orders" && req.method==="POST"){
    const m=await authenticatedMember(req);if(!m)return send(res,401,{error:"Kontör siparişi için onaylı üye hesabınızla giriş yapın."});
    let b;try{b=await jsonBody(req);}catch(e){return send(res,400,{error:e.message});}
    const pkg=Number(b.packageTokens);
    if(![200,500,1000,2500,5000].includes(pkg))return send(res,400,{error:"Kontör paketi geçersiz."});
    const amount=Number(process.env["TOKEN_PRICE_"+pkg+"_KURUS"]||0);
    if(!process.env.ELBANKO_PAYMENT_IBAN||!process.env.ELBANKO_PAYMENT_HOLDER||!Number.isSafeInteger(amount)||amount<=0)return send(res,503,{error:"Havale ile sipariş henüz açılamıyor. Yönetici Render ortamına alıcı IBAN'ını, hesap sahibini ve beş paketin TL fiyatlarını eklemeli. Ödeme alınmadı; kontör eklenmedi."});
    try{const r=await db.query("INSERT INTO payment_orders(member_id,provider,package_tokens,amount_kurus,status) VALUES($1,'iban',$2,$3,'pending') RETURNING id,package_tokens,amount_kurus,status,created_at",[m.id,pkg,amount]);return send(res,201,{ok:true,order:r.rows[0],payment:{iban:process.env.ELBANKO_PAYMENT_IBAN,bank:process.env.ELBANKO_PAYMENT_BANK||"",accountHolder:process.env.ELBANKO_PAYMENT_HOLDER}});}
    catch(e){console.error("Payment order create failed",e.message);return send(res,500,{error:"Kontör siparişi oluşturulamadı."});}
  }
  if(url.pathname==="/api/payments/orders/notify" && req.method==="POST"){
    const m=await authenticatedMember(req);if(!m)return send(res,401,{error:"Ödeme bildirimi için giriş yapın."});
    let b;try{b=await jsonBody(req);}catch(e){return send(res,400,{error:e.message});}
    const id=Number(b.orderId),note=String(b.note||"").trim().slice(0,500),reference=String(b.bankReference||"").trim().slice(0,160);
    if(!Number.isSafeInteger(id)||id<=0)return send(res,400,{error:"Sipariş numarası geçersiz."});
    try{const r=await db.query("UPDATE payment_orders SET status='reported',payment_note=$1,provider_reference=$2,submitted_at=NOW() WHERE id=$3 AND member_id=$4 AND status='pending' RETURNING id,status",[note,reference,id,m.id]);if(!r.rowCount)return send(res,409,{error:"Sipariş bulunamadı veya daha önce bildirilmiş/onaylanmış."});return send(res,200,{ok:true,order:r.rows[0],message:"Ödeme bildirimi alındı. Kontör, yönetici banka hareketini doğrulayana kadar yüklenmez."});}
    catch(e){console.error("Payment notification failed",e.message);return send(res,500,{error:"Ödeme bildirimi kaydedilemedi."});}
  }
  if(url.pathname==="/api/admin/payment-orders" && req.method==="GET"){
    const key=String(req.headers["x-admin-key"]||"");
    if(!process.env.ELBANKO_ADMIN_KEY||!safeEqual(key,process.env.ELBANKO_ADMIN_KEY))return send(res,403,{error:"Yönetici yetkisi doğrulanamadı."});
    try{const r=await db.query("SELECT o.id,o.member_id,m.full_name,m.username,m.email,o.package_tokens,o.amount_kurus,o.status,o.provider_reference,o.payment_note,o.created_at,o.submitted_at FROM payment_orders o JOIN members m ON m.id=o.member_id ORDER BY CASE WHEN o.status='reported' THEN 0 ELSE 1 END,o.created_at DESC LIMIT 100");return send(res,200,{orders:r.rows});}
    catch(e){console.error("Admin payment orders failed",e.message);return send(res,500,{error:"Yönetici sipariş listesi alınamadı."});}
  }
  if(url.pathname==="/api/admin/payment-orders/approve" && req.method==="POST"){
    const key=String(req.headers["x-admin-key"]||"");
    if(!process.env.ELBANKO_ADMIN_KEY||!safeEqual(key,process.env.ELBANKO_ADMIN_KEY))return send(res,403,{error:"Yönetici yetkisi doğrulanamadı."});
    let b;try{b=await jsonBody(req);}catch(e){return send(res,400,{error:e.message});}
    const id=Number(b.orderId);
    if(!Number.isSafeInteger(id)||id<=0)return send(res,400,{error:"Sipariş numarası geçersiz."});
    const client=await db.connect();
    try{
      await client.query("BEGIN");
      const r=await client.query("SELECT * FROM payment_orders WHERE id=$1 FOR UPDATE",[id]);
      const o=r.rows[0];if(!o){await client.query("ROLLBACK");return send(res,404,{error:"Sipariş bulunamadı."});}
      if(o.status!=="reported"){await client.query("ROLLBACK");return send(res,409,{error:"Yalnızca üyenin bildirdiği, henüz onaylanmamış sipariş onaylanabilir."});}
      const w=await client.query("INSERT INTO member_wallets(member_id,balance) VALUES($1,0) ON CONFLICT(member_id) DO UPDATE SET member_id=EXCLUDED.member_id RETURNING balance",[o.member_id]);
      const before=Number(w.rows[0].balance);
      const upd=await client.query("UPDATE member_wallets SET balance=balance+$1,updated_at=NOW() WHERE member_id=$2 RETURNING balance",[o.package_tokens,o.member_id]);
      const after=Number(upd.rows[0].balance);
      await client.query("INSERT INTO wallet_transactions(member_id,amount,balance_after,kind,status,reference,description) VALUES($1,$2,$3,'iban_topup','approved',$4,$5)",[o.member_id,o.package_tokens,after,"iban-order-"+o.id,"IBAN ödeme onayı · Sipariş #"+o.id]);
      await client.query("UPDATE payment_orders SET status='approved',paid_at=NOW(),reviewed_at=NOW(),reviewed_by='admin' WHERE id=$1",[id]);
      await client.query("COMMIT");
      return send(res,200,{ok:true,orderId:id,memberId:Number(o.member_id),tokensAdded:Number(o.package_tokens),balanceBefore:before,balanceAfter:after,message:"Onaylandı ve kontör bir kez yüklendi."});
    }catch(e){await client.query("ROLLBACK").catch(()=>{});console.error("Admin payment approval failed",e.message);return send(res,500,{error:"Onay işlemi başarısız oldu; kontör yükleme tamamlanmadı."});}
    finally{client.release();}
  }

  if(url.pathname==="/api/bank-transfer/orders" && req.method==="POST"){
    const m=await authenticatedMember(req);if(!m)return send(res,401,{error:"Ödeme talebi için onaylı üye hesabınızla giriş yapın."});
    let b;try{b=await jsonBody(req);}catch(e){return send(res,400,{error:e.message});}
    const pkg=Number(b.packageTokens),prices={200:process.env.PACKAGE_PRICE_200_TL,500:process.env.PACKAGE_PRICE_500_TL,1000:process.env.PACKAGE_PRICE_1000_TL,2500:process.env.PACKAGE_PRICE_2500_TL,5000:process.env.PACKAGE_PRICE_5000_TL};
    if(![200,500,1000,2500,5000].includes(pkg))return send(res,400,{error:"Kontör paketi geçersiz."});
    const amount=Number(prices[pkg]);
    if(!Number.isFinite(amount)||amount<=0)return send(res,503,{error:"Bu paketin TL fiyatı henüz yönetici tarafından ayarlanmadı. Fiyat belirlenmeden ödeme emri oluşturulmadı."});
    if(!process.env.BANK_IBAN||!process.env.BANK_ACCOUNT_HOLDER||!process.env.BANK_NAME)return send(res,503,{error:"Yönetici banka adı, hesap sahibi ve IBAN bilgilerini sunucu ayarlarına henüz eklemedi. Para göndermeyin."});
    try{
      const r=await db.query("INSERT INTO payment_orders(member_id,provider,package_tokens,amount_kurus,status) VALUES($1,'bank_transfer',$2,$3,'pending') RETURNING id,package_tokens,amount_kurus,status,created_at",[m.id,pkg,Math.round(amount*100)]);
      const o=r.rows[0];return send(res,201,{ok:true,order:{id:o.id,packageTokens:Number(o.package_tokens),amountKurus:Number(o.amount_kurus),status:o.status,createdAt:o.created_at},bank:{name:process.env.BANK_NAME,accountHolder:process.env.BANK_ACCOUNT_HOLDER,iban:process.env.BANK_IBAN},message:"Sipariş oluşturuldu. Transferi gönderdikten sonra ödeme bildirimini yapın. Kontör, yönetici banka hareketini doğrulayana kadar eklenmez."});
    }catch(e){console.error("Bank transfer order failed",e.message);return send(res,500,{error:"Ödeme talebi oluşturulamadı."});}
  }
  if(url.pathname==="/api/bank-transfer/orders" && req.method==="GET"){
    const m=await authenticatedMember(req);if(!m)return send(res,401,{error:"Giriş yapmanız gerekiyor."});
    try{const r=await db.query("SELECT id,package_tokens,amount_kurus,status,transfer_note,created_at,paid_at FROM payment_orders WHERE member_id=$1 ORDER BY created_at DESC LIMIT 50",[m.id]);return send(res,200,{orders:r.rows});}
    catch(e){console.error("Bank orders read failed",e.message);return send(res,500,{error:"Ödeme talepleri okunamadı."});}
  }
  if(url.pathname==="/api/bank-transfer/orders/report" && req.method==="POST"){
    const m=await authenticatedMember(req);if(!m)return send(res,401,{error:"Giriş yapmanız gerekiyor."});
    let b;try{b=await jsonBody(req);}catch(e){return send(res,400,{error:e.message});}
    const id=Number(b.orderId),note=String(b.transferNote||"").trim().slice(0,160);
    if(!Number.isSafeInteger(id)||id<=0)return send(res,400,{error:"Sipariş numarası geçersiz."});
    try{const r=await db.query("UPDATE payment_orders SET status='reported',transfer_note=$3 WHERE id=$1 AND member_id=$2 AND status='pending' RETURNING id,status",[id,m.id,note||null]);if(!r.rowCount)return send(res,409,{error:"Sipariş bulunamadı veya daha önce bildirilmiş/sonuçlanmış."});return send(res,200,{ok:true,order:r.rows[0],message:"Ödeme bildirimi alındı. Bu bildirim banka ödemesini doğrulamaz; yönetici hesabı kontrol edecektir."});}
    catch(e){console.error("Transfer report failed",e.message);return send(res,500,{error:"Ödeme bildirimi kaydedilemedi."});}
  }
  if(url.pathname==="/api/admin/bank-transfer/orders" && req.method==="GET"){
    const key=String(req.headers["x-admin-key"]||"");
    if(!process.env.ADMIN_API_KEY||!safeEqual(key,process.env.ADMIN_API_KEY))return send(res,403,{error:"Yönetici erişimi doğrulanamadı. ADMIN_API_KEY sunucuya güvenli biçimde eklenmelidir."});
    if(!db||!dbReady)return send(res,503,{error:"Veritabanı hazır değil."});
    try{const r=await db.query("SELECT o.id,o.member_id,m.full_name,m.username,m.email,o.package_tokens,o.amount_kurus,o.status,o.transfer_note,o.created_at FROM payment_orders o JOIN members m ON m.id=o.member_id ORDER BY CASE o.status WHEN 'reported' THEN 0 ELSE 1 END,o.created_at DESC LIMIT 200");return send(res,200,{orders:r.rows});}
    catch(e){console.error("Admin bank orders failed",e.message);return send(res,500,{error:"Yönetici siparişleri okunamadı."});}
  }
  if(url.pathname==="/api/admin/bank-transfer/orders/approve" && req.method==="POST"){
    const key=String(req.headers["x-admin-key"]||"");
    if(!process.env.ADMIN_API_KEY||!safeEqual(key,process.env.ADMIN_API_KEY))return send(res,403,{error:"Yönetici erişimi doğrulanamadı. ADMIN_API_KEY sunucuya güvenli biçimde eklenmelidir."});
    let b;try{b=await jsonBody(req);}catch(e){return send(res,400,{error:e.message});}
    const id=Number(b.orderId);if(!Number.isSafeInteger(id)||id<=0)return send(res,400,{error:"Sipariş numarası geçersiz."});
    const client=await db.connect();
    try{
      await client.query("BEGIN");
      const q=await client.query("SELECT * FROM payment_orders WHERE id=$1 FOR UPDATE",[id]);const o=q.rows[0];
      if(!o){await client.query("ROLLBACK");return send(res,404,{error:"Sipariş bulunamadı."});}
      if(o.status!=="reported"){await client.query("ROLLBACK");return send(res,409,{error:"Sadece ödeme bildirimi yapılmış siparişler onaylanabilir."});}
      const updated=await client.query("INSERT INTO member_wallets(member_id,balance) VALUES($1,$2) ON CONFLICT(member_id) DO UPDATE SET balance=member_wallets.balance+EXCLUDED.balance,updated_at=NOW() RETURNING balance",[o.member_id,o.package_tokens]);
      const balance=Number(updated.rows[0].balance);
      await client.query("INSERT INTO wallet_transactions(member_id,amount,balance_after,kind,status,reference,description) VALUES($1,$2,$3,'bank_transfer','approved',$4,$5)",[o.member_id,o.package_tokens,balance,"bank-order-"+o.id,"Banka transferi onaylandı · Sipariş #"+o.id]);
      await client.query("UPDATE payment_orders SET status='approved',paid_at=NOW(),approved_by='admin' WHERE id=$1",[id]);
      await client.query("COMMIT");
      return send(res,200,{ok:true,orderId:id,memberId:Number(o.member_id),creditedTokens:Number(o.package_tokens),balance,message:"Kontör, yönetici onayıyla bir kez yüklendi."});
    }catch(e){await client.query("ROLLBACK").catch(()=>{});console.error("Admin approve bank transfer failed",e.message);return send(res,500,{error:"Onay tamamlanamadı."});}
    finally{client.release();}
  }
  if(url.pathname==="/api/admin/bank-transfer/orders/reject" && req.method==="POST"){
    const key=String(req.headers["x-admin-key"]||"");
    if(!process.env.ADMIN_API_KEY||!safeEqual(key,process.env.ADMIN_API_KEY))return send(res,403,{error:"Yönetici erişimi doğrulanamadı."});
    let b;try{b=await jsonBody(req);}catch(e){return send(res,400,{error:e.message});}
    const id=Number(b.orderId),reason=String(b.reason||"Ödeme doğrulanamadı").slice(0,180);
    if(!Number.isSafeInteger(id)||id<=0)return send(res,400,{error:"Sipariş numarası geçersiz."});
    try{const r=await db.query("UPDATE payment_orders SET status='rejected',transfer_note=COALESCE(transfer_note,'') WHERE id=$1 AND status='reported' RETURNING id,status",[id]);if(!r.rowCount)return send(res,409,{error:"Sipariş bulunamadı veya onaylanmış."});return send(res,200,{ok:true,order:r.rows[0],message:reason+" — kontör yüklenmedi."});}
    catch(e){console.error("Reject bank transfer failed",e.message);return send(res,500,{error:"Sipariş reddedilemedi."});}
  }

  if(url.pathname==="/api/payments/info" && req.method==="GET"){
    const prices={};for(const n of [200,500,1000,2500,5000]){const raw=String(process.env["PACKAGE_PRICE_"+n+"_TRY"]||"").trim().replace(",",".");const value=Number(raw);prices[n]=raw!==""&&Number.isFinite(value)&&value>0?Math.round(value*100):null;}
    const iban=String(process.env.BANK_IBAN||"").replace(/\s+/g,"").toUpperCase();
    const accountHolder=String(process.env.BANK_ACCOUNT_NAME||"").trim();
    const bank=String(process.env.BANK_NAME||"").trim();
    const ready=Boolean(iban&&accountHolder&&/^[A-Z]{2}[0-9A-Z]{13,32}$/.test(iban)&&[200,500,1000,2500,5000].every(n=>prices[n]));
    return send(res,200,{ready,iban:ready?iban:null,accountHolder:ready?accountHolder:null,bank:ready?bank:null,prices});
  }
  if(url.pathname==="/api/payments/orders" && req.method==="POST"){
    const m=await authenticatedMember(req);if(!m)return send(res,401,{error:"Sipariş oluşturmak için onaylı üye hesabınızla giriş yapın."});
    if(!db||!dbReady)return send(res,503,{error:"Üyelik veri tabanı bağlı değil."});
    let b;try{b=await jsonBody(req);}catch(e){return send(res,400,{error:e.message});}
    const pkg=Number(b.packageTokens);if(![200,500,1000,2500,5000].includes(pkg))return send(res,400,{error:"Kontör paketi geçersiz."});
    const raw=String(process.env["PACKAGE_PRICE_"+pkg+"_TRY"]||"").trim().replace(",",".");const price=Number(raw);
    const iban=String(process.env.BANK_IBAN||"").replace(/\s+/g,"").toUpperCase(),accountHolder=String(process.env.BANK_ACCOUNT_NAME||"").trim(),bank=String(process.env.BANK_NAME||"").trim();
    if(!iban||!accountHolder||!/^[A-Z]{2}[0-9A-Z]{13,32}$/.test(iban)||!Number.isFinite(price)||price<=0)return send(res,503,{error:"IBAN, hesap sahibi ve geçerli paket fiyatları henüz sunucuya tanımlanmamış. Sipariş açılamadı; para göndermeyin ve kontör yüklenmedi."});
    try{const r=await db.query("INSERT INTO payment_orders(member_id,provider,package_tokens,amount_kurus,status) VALUES($1,'bank_transfer',$2,$3,'pending') RETURNING id,package_tokens,amount_kurus,status,created_at",[m.id,pkg,Math.round(price*100)]);return send(res,201,{ok:true,order:r.rows[0],payment:{iban,accountHolder,bank}});}
    catch(e){console.error("Bank transfer order creation failed",e.message);return send(res,500,{error:"Sipariş oluşturulamadı."});}
  }
  if(url.pathname==="/api/payments/orders/notify" && req.method==="POST"){
    const m=await authenticatedMember(req);if(!m)return send(res,401,{error:"Ödeme bildirmek için giriş yapın."});
    let b;try{b=await jsonBody(req);}catch(e){return send(res,400,{error:e.message});}
    const id=Number(b.orderId);if(!Number.isSafeInteger(id)||id<1)return send(res,400,{error:"Sipariş numarası geçersiz."});
    try{const r=await db.query("UPDATE payment_orders SET status='reported',provider_reference=LEFT(NULLIF($1,''),160),payment_note=LEFT(NULLIF($2,''),500),notified_at=NOW() WHERE id=$3 AND member_id=$4 AND status='pending' RETURNING id,status",[String(b.bankReference||"").trim(),String(b.note||"").trim(),id,m.id]);if(!r.rowCount)return send(res,409,{error:"Sipariş bulunamadı veya bu sipariş için daha önce bildirim yapılmış/işlem tamamlanmış."});return send(res,200,{ok:true,message:"Ödeme bildiriminiz yöneticiye iletildi. Kontör, yönetici banka hareketini doğrulayıp onaylayana kadar yüklenmeyecek."});}
    catch(e){console.error("Payment report failed",e.message);return send(res,500,{error:"Ödeme bildirimi kaydedilemedi."});}
  }
  if(url.pathname==="/api/payments/orders" && req.method==="GET"){
    const m=await authenticatedMember(req);if(!m)return send(res,401,{error:"Sipariş geçmişi için giriş yapın."});
    try{const r=await db.query("SELECT id,package_tokens,amount_kurus,status,provider_reference,created_at,notified_at,paid_at FROM payment_orders WHERE member_id=$1 ORDER BY created_at DESC LIMIT 100",[m.id]);return send(res,200,{orders:r.rows});}
    catch(e){console.error("Member payment orders failed",e.message);return send(res,500,{error:"Sipariş geçmişi alınamadı."});}
  }
  if(url.pathname==="/api/admin/payment-orders" && req.method==="GET"){
    const key=String(req.headers["x-admin-key"]||"");const expected=process.env.ELBANKO_ADMIN_KEY||process.env.ADMIN_PASSWORD||"";
    if(!expected||!safeEqual(key,expected))return send(res,401,{error:"Yönetici anahtarı hatalı veya ELBANKO_ADMIN_KEY ayarlanmamış."});
    if(!db||!dbReady)return send(res,503,{error:"Üyelik veri tabanı bağlı değil."});
    try{const r=await db.query("SELECT p.id,p.package_tokens,p.amount_kurus,p.status,p.provider_reference,p.payment_note,p.created_at,p.notified_at,m.full_name,m.username,m.email FROM payment_orders p JOIN members m ON m.id=p.member_id ORDER BY CASE p.status WHEN 'reported' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,p.created_at DESC LIMIT 200");return send(res,200,{orders:r.rows});}
    catch(e){console.error("Admin payment list failed",e.message);return send(res,500,{error:"Ödeme siparişleri alınamadı."});}
  }
  if(url.pathname==="/api/admin/payment-orders/approve" && req.method==="POST"){
    const key=String(req.headers["x-admin-key"]||"");const expected=process.env.ELBANKO_ADMIN_KEY||process.env.ADMIN_PASSWORD||"";
    if(!expected||!safeEqual(key,expected))return send(res,401,{error:"Yönetici anahtarı hatalı veya ELBANKO_ADMIN_KEY ayarlanmamış."});
    if(!db||!dbReady)return send(res,503,{error:"Üyelik veri tabanı bağlı değil."});
    let b;try{b=await jsonBody(req);}catch(e){return send(res,400,{error:e.message});}
    const id=Number(b.orderId);if(!Number.isSafeInteger(id)||id<1)return send(res,400,{error:"Sipariş numarası geçersiz."});
    const client=await db.connect();
    try{
      await client.query("BEGIN");
      const order=await client.query("SELECT id,member_id,package_tokens,amount_kurus,status FROM payment_orders WHERE id=$1 FOR UPDATE",[id]);
      if(!order.rowCount){await client.query("ROLLBACK");return send(res,404,{error:"Sipariş bulunamadı."});}
      const o=order.rows[0];if(o.status!=="reported"){await client.query("ROLLBACK");return send(res,409,{error:"Bu sipariş ödeme bildirimi beklemiyor veya daha önce işlenmiş."});}
      await client.query("INSERT INTO member_wallets(member_id,balance) VALUES($1,0) ON CONFLICT(member_id) DO NOTHING",[o.member_id]);
      const updated=await client.query("UPDATE member_wallets SET balance=balance+$1,updated_at=NOW() WHERE member_id=$2 RETURNING balance",[Number(o.package_tokens),o.member_id]);
      const ref="bank-order-"+o.id;
      await client.query("INSERT INTO wallet_transactions(member_id,amount,balance_after,kind,status,reference,description) VALUES($1,$2,$3,'bank_transfer','completed',$4,$5)",[o.member_id,Number(o.package_tokens),Number(updated.rows[0].balance),ref,"IBAN ödemesi onaylandı · Sipariş #"+o.id]);
      await client.query("UPDATE payment_orders SET status='approved',paid_at=NOW() WHERE id=$1",[o.id]);
      await client.query("COMMIT");
      return send(res,200,{ok:true,orderId:o.id,tokensAdded:Number(o.package_tokens),balance:Number(updated.rows[0].balance),message:"Banka ödemesi yönetici tarafından onaylandı; kontör yüklendi."});
    }catch(e){await client.query("ROLLBACK").catch(()=>{});console.error("Admin payment approval failed",e.message);return send(res,500,{error:"Onay ve kontör yükleme işlemi tamamlanamadı."});}
    finally{client.release();}
  }
  if(url.pathname==="/api/races" && req.method==="GET"){
    if(cache.data && cache.until>Date.now()) return send(res,200,{...cache.data,cached:true});
    try{
      if(!refreshPromise) refreshPromise=getDailyRaces();
      const data=await refreshPromise;
      cache={data,until:Date.now()+5*60*1000};
      return send(res,200,{...data,cached:false});
    }catch(e){
      console.error("EL BANKO daily races failed",e.message);
      return send(res,502,{error:"Günlük yarış verisi şu anda resmî kaynaktan alınamadı.",detail:String(e.message||e),source:"EL BANKO",checkedAt:new Date().toISOString()});
    }finally{refreshPromise=null;}
  }
  return send(res,404,{error:"Bulunamadı"});
});
server.listen(PORT,"0.0.0.0",()=>{
  console.log("EL BANKO race API running on "+PORT);
  initMembers().catch(e=>console.error("Member DB setup failed:",e.message));
  const warmup=getDailyRaces();
  refreshPromise=warmup;
  warmup.then(data=>{
    cache={data,until:Date.now()+5*60*1000};
    const raceCount=data.courses.reduce((n,c)=>n+(c.races||[]).length,0);
    const horseCount=data.courses.reduce((n,c)=>n+(c.horseCount||0),0);
    console.log("EL BANKO race data ready: "+data.courses.length+" courses, "+raceCount+" races, "+horseCount+" horses");
  },e=>console.error("EL BANKO initial race data check failed:",e.message)).finally(()=>{
    if(refreshPromise===warmup)refreshPromise=null;
  });
});
