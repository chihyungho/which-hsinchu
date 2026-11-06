// 新竹市民性格測驗：靜態網頁 + 結果／問卷儲存伺服器
// 只用 Node.js 內建模組，不需 npm install。需要 Node.js 18 以上。
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const PUBLIC_DIR = path.join(__dirname, "public");
const USE_BASELINE = process.env.USE_BASELINE !== "0";

const TYPES = ["---", "--+", "-+-", "-++", "+--", "+-+", "++-", "+++"];
const CANDS = ["何志勇", "高虹安", "莊競程"];
const CAND_IDS = ["ho", "kao", "chuang"];
const SURVEY = {
  right: ["有", "沒有", "不確定"],
  intent: ["一定會去投", "可能會去投", "可能不會去投", "一定不會去投", "還沒決定"],
  support: [...CANDS, "尚未決定", "不願透露"],
  outlook: [...CANDS, "不知道"],
};
const RID_RE = /^[A-Za-z0-9-]{8,64}$/;

fs.mkdirSync(DATA_DIR, { recursive: true });
function load(name, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), "utf8")); }
  catch { return fallback; }
}
const results = load("results.json", {});
const surveys = load("surveys.json", {});
const baseline = USE_BASELINE ? load("baseline.json", { n: 0, counts: {} }) : { n: 0, counts: {} };

// 寫檔：先寫暫存檔再改名，避免中途斷電毀損
const pending = new Set();
function save(name, obj) {
  if (pending.has(name)) return;
  pending.add(name);
  setTimeout(() => {
    pending.delete(name);
    const file = path.join(DATA_DIR, name);
    fs.writeFileSync(file + ".tmp", JSON.stringify(obj));
    fs.renameSync(file + ".tmp", file);
  }, 300);
}

// 簡易流量限制：每個 IP 每分鐘 60 次寫入（IP 不寫入檔案）
const hits = new Map();
function limited(ip) {
  const now = Date.now(), w = hits.get(ip) || [];
  const recent = w.filter(t => now - t < 60000);
  recent.push(now); hits.set(ip, recent);
  return recent.length > 60;
}
setInterval(() => hits.clear(), 10 * 60000).unref();

function send(res, code, body, type = "application/json; charset=utf-8", extra = {}) {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...extra });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", c => { data += c; if (data.length > 4096) { reject(new Error("too large")); req.destroy(); } });
    req.on("end", () => { try { resolve(JSON.parse(data || "{}")); } catch { reject(new Error("bad json")); } });
  });
}
function isAdmin(url) {
  const t = url.searchParams.get("token") || "";
  if (!ADMIN_TOKEN || t.length !== ADMIN_TOKEN.length) return false;
  return crypto.timingSafeEqual(Buffer.from(t), Buffer.from(ADMIN_TOKEN));
}
function stats() {
  const counts = { ...baseline.counts };
  let n = baseline.n || 0;
  const best = {};
  let bestN = 0; // 只計真實玩家，不使用模擬資料
  for (const r of Object.values(results)) {
    counts[r.type] = (counts[r.type] || 0) + 1; n++;
    if (Array.isArray(r.best)) { bestN++; for (const id of r.best) best[id] = (best[id] || 0) + 1; }
  }
  return { n, counts, best, bestN, seed: baseline.n || 0, real: n - (baseline.n || 0) };
}
function tally(field) {
  const out = {};
  for (const s of Object.values(surveys)) out[s[field]] = (out[s[field]] || 0) + 1;
  return out;
}
const csvCell = v => `"${String(v ?? "").replace(/"/g, '""')}"`;

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".ico": "image/x-icon" };

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  try {
    if (req.method === "GET" && url.pathname === "/api/stats") return send(res, 200, stats());

    if (req.method === "POST" && (url.pathname === "/api/result" || url.pathname === "/api/survey")) {
      if (limited(ip)) return send(res, 429, { error: "too many requests" });
      const b = await readBody(req);
      if (!RID_RE.test(b.rid || "")) return send(res, 400, { error: "bad id" });
      if (!TYPES.includes(b.type)) return send(res, 400, { error: "bad type" });
      if (url.pathname === "/api/result") {
        const best = Array.isArray(b.best) ? [...new Set(b.best)] : [];
        if (best.some(id => !CAND_IDS.includes(id))) return send(res, 400, { error: "bad best" });
        results[b.rid] = { type: b.type, best, at: new Date().toISOString() };
        save("results.json", results);
      } else {
        const row = { type: b.type, at: new Date().toISOString() };
        for (const [k, opts] of Object.entries(SURVEY)) {
          if (!opts.includes(b[k])) return send(res, 400, { error: "bad " + k });
          row[k] = b[k];
        }
        surveys[b.rid] = row;
        save("surveys.json", surveys);
      }
      return send(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/admin/")) {
      if (!isAdmin(url)) return send(res, 403, { error: "forbidden" });
      if (url.pathname === "/api/admin/summary") {
        return send(res, 200, {
          note: "僅含真實填答，不含模擬基準資料",
          respondents: Object.keys(results).length,
          surveys: Object.keys(surveys).length,
          types: Object.values(results).reduce((o, r) => (o[r.type] = (o[r.type] || 0) + 1, o), {}),
          bestMatch: Object.values(results).reduce((o, r) => { for (const id of r.best || []) o[CANDS[CAND_IDS.indexOf(id)]] = (o[CANDS[CAND_IDS.indexOf(id)]] || 0) + 1; return o; }, {}),
          right: tally("right"), intent: tally("intent"), support: tally("support"), outlook: tally("outlook"),
        });
      }
      if (url.pathname === "/api/admin/surveys.csv") {
        const head = ["填答時間", "性格類型", "投票權", "投票意願", "支持", "看好"];
        const lines = Object.values(surveys).map(s => [s.at, s.type, s.right, s.intent, s.support, s.outlook].map(csvCell).join(","));
        return send(res, 200, "﻿" + [head.map(csvCell).join(","), ...lines].join("\r\n"),
          "text/csv; charset=utf-8", { "Content-Disposition": 'attachment; filename="surveys.csv"' });
      }
      return send(res, 404, { error: "not found" });
    }

    if (req.method === "GET") {
      const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
      const file = path.join(PUBLIC_DIR, rel);
      if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, "forbidden", "text/plain");
      return fs.readFile(file, (err, buf) => err
        ? send(res, 404, "not found", "text/plain")
        : send(res, 200, buf, MIME[path.extname(file)] || "application/octet-stream", { "Cache-Control": "public, max-age=300" }));
    }
    send(res, 405, { error: "method not allowed" });
  } catch (e) {
    send(res, 400, { error: e.message });
  }
}).listen(PORT, () => {
  console.log(`新竹市民性格測驗：http://localhost:${PORT}`);
  if (!ADMIN_TOKEN) console.log("提醒：未設定 ADMIN_TOKEN，管理匯出功能已停用");
});
