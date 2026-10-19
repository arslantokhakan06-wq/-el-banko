const http = require("node:http");
const SITE_ORIGIN = process.env.SITE_ORIGIN || "https://el-banko.onrender.com";
const PORT = process.env.PORT || 10000;
const TJK_HOME = "https://www.tjk.org/TR/YarisSever/Info/Page/GunlukYarisProgrami";
let cache = { until: 0, data: null };

function send(res,status,data){
  res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Access-Control-Allow-Origin":SITE_ORIGIN,"Access-Control-Allow-Methods":"GET, OPTIONS","Access-Control-Allow-Headers":"Content-Type","Cache-Control":"public, max-age=60","Vary":"Origin"});
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
const server=http.createServer(async(req,res)=>{
  if(req.method==="OPTIONS"){res.writeHead(204,{"Access-Control-Allow-Origin":SITE_ORIGIN,"Access-Control-Allow-Methods":"GET, OPTIONS"});return res.end();}
  const url=new URL(req.url,"http://localhost");
  if(url.pathname==="/health") return send(res,200,{ok:true,service:"EL BANKO race data",time:new Date().toISOString()});
  if(url.pathname==="/api/races" && req.method==="GET"){
    if(cache.data && cache.until>Date.now()) return send(res,200,{...cache.data,cached:true});
    try{const data=await getDailyRaces();cache={data,until:Date.now()+5*60*1000};return send(res,200,{...data,cached:false});}
    catch(e){return send(res,502,{error:"Günlük yarış verisi şu anda resmî kaynaktan alınamadı.",detail:String(e.message||e),source:"TJK",checkedAt:new Date().toISOString()});}
  }
  return send(res,404,{error:"Bulunamadı"});
});
server.listen(PORT,"0.0.0.0",()=>console.log("EL BANKO race API running on "+PORT));
