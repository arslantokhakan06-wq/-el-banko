const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PORT = process.env.PORT || 10000;
const SITE_ORIGIN = process.env.SITE_ORIGIN || "https://el-banko.onrender.com";
const TJK_URL = "https://www.tjk.org/TR/Kurumsal/Info/Page/GunlukYarisProgrami";

function send(res, status, data, type = "application/json; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "Access-Control-Allow-Origin": SITE_ORIGIN,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store"
  });
  res.end(type.startsWith("application/json") ? JSON.stringify(data) : data);
}
function cleanText(s) {
  return s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&").replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, " ").trim();
}
function extractRows(html) {
  const rows = [];
  const re = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let match;
  while ((match = re.exec(html)) && rows.length < 180) {
    const cells = [];
    const cellRe = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let cell;
    while ((cell = cellRe.exec(match[1]))) {
      const value = cleanText(cell[1]);
      if (value) cells.push(value);
    }
    if (cells.length >= 2) rows.push(cells);
  }
  return rows;
}
async function getRaces() {
  const response = await fetch(TJK_URL, {
    headers: { "User-Agent": "EL-BANKO-DailyProgram/1.0 (+https://el-banko.onrender.com)", "Accept": "text/html,application/xhtml+xml" },
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error("Resmî yarış sayfası HTTP " + response.status);
  const html = await response.text();
  const title = cleanText((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [,"Günlük Yarış Programı"])[1]);
  const rows = extractRows(html);
  const plain = cleanText(html);
  if (!plain || plain.length < 500) throw new Error("Resmî yarış sayfasından okunabilir veri alınamadı.");
  return {
    source: "Türkiye Jokey Kulübü (TJK)",
    sourceUrl: TJK_URL,
    fetchedAt: new Date().toISOString(),
    title,
    rows,
    notice: rows.length ? null : "Sayfa alındı ancak yarış tablosu otomatik ayrıştırılamadı. Veri uydurulmadı.",
    pageText: rows.length ? undefined : plain.slice(0, 5000)
  };
}
const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, {});
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/health") return send(res, 200, { ok: true, service: "el-banko-race-data", timestamp: new Date().toISOString() });
  if (url.pathname === "/api/races" && req.method === "GET") {
    try {
      const data = await getRaces();
      return send(res, 200, data);
    } catch (err) {
      return send(res, 502, {
        error: "Günlük yarış verisi şu anda resmî kaynaktan alınamadı.",
        detail: String(err && err.message || err),
        source: "Türkiye Jokey Kulübü (TJK)",
        checkedAt: new Date().toISOString()
      });
    }
  }
  if (url.pathname === "/" || url.pathname === "/index.html") {
    const file = path.join(__dirname, "index.html");
    if (!fs.existsSync(file)) return send(res, 404, "EL BANKO ana sayfası bulunamadı.", "text/plain; charset=utf-8");
    return send(res, 200, fs.readFileSync(file, "utf8"), "text/html; charset=utf-8");
  }
  return send(res, 404, { error: "Bulunamadı" });
});
server.listen(PORT, "0.0.0.0", () => console.log("EL BANKO race API listening on " + PORT));
