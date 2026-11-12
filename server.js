// Trader Hub Live — بغیر کسی لائبریری کے، Node 18+ پر چلتا ہے
const http = require("http"), fs = require("fs"), path = require("path");
const PORT = process.env.PORT || 3000;
const FRED = process.env.FRED_API_KEY || ""; // اختیاری: fred.stlouisfed.org سے مفت

const PAIRS = {
  EURUSD: ["EURUSD=X", "EUR", "USD"], GBPUSD: ["GBPUSD=X", "GBP", "USD"],
  USDJPY: ["USDJPY=X", "USD", "JPY"], AUDUSD: ["AUDUSD=X", "AUD", "USD"],
  USDCAD: ["USDCAD=X", "USD", "CAD"], USDCHF: ["USDCHF=X", "USD", "CHF"],
  NZDUSD: ["NZDUSD=X", "NZD", "USD"], XAUUSD: ["GC=F", "GOLD", null],
  US30: ["^DJI", null, null], NAS100: ["^NDX", null, null], BTCUSD: ["BTC-USD", null, null],
};
const COT_NAMES = { EUR: "EURO FX", GBP: "BRITISH POUND", JPY: "JAPANESE YEN", AUD: "AUSTRALIAN DOLLAR",
  CAD: "CANADIAN DOLLAR", CHF: "SWISS FRANC", NZD: "NZ DOLLAR", GOLD: "GOLD", USD: "USD INDEX" };
const FEEDS = [
  ["FXStreet", "https://www.fxstreet.com/rss/news"],
  ["Investing", "https://www.investing.com/rss/news_1.rss"],
  ["ForexLive", "https://www.forexlive.com/feed/news"],
];
const WEIGHTS = { d1: 1.5, h1: 1, rsi: 1, macd: 0.8, cot: 1.5 };
const UA = { "User-Agent": "Mozilla/5.0 (TraderHub)" };

// ---------- cache ----------
const C = {};
async function cached(key, ttl, fn, fallback) {
  const c = C[key];
  if (c && Date.now() - c.t < ttl) return c.v;
  try { const v = await fn(); C[key] = { t: Date.now(), v }; return v; }
  catch (e) { console.log(key, "failed:", e.message); return c ? c.v : fallback; }
}
const get = async (u) => { const r = await fetch(u, { headers: UA }); if (!r.ok) throw new Error(r.status + " " + u); return r; };

// ---------- indicators ----------
function emaSeries(a, n) { const k = 2 / (n + 1); const o = []; let e = a[0]; for (const x of a) { e = x * k + e * (1 - k); o.push(e); } return o; }
function rsi(a, n = 14) {
  if (a.length < n + 1) return null; let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = a[i] - a[i - 1]; d > 0 ? (g += d) : (l -= d); }
  g /= n; l /= n;
  for (let i = n + 1; i < a.length; i++) { const d = a[i] - a[i - 1]; g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}
function trend(c) {
  if (c.length < 60) return 0;
  const e50 = emaSeries(c, 50).pop(), e200 = emaSeries(c, Math.min(200, c.length - 1)).pop(), p = c[c.length - 1];
  if (p > e50 && e50 > e200) return 2; if (p < e50 && e50 < e200) return -2;
  return p > e200 ? 1 : -1;
}
function macdScore(c) {
  if (c.length < 40) return 0;
  const e12 = emaSeries(c, 12), e26 = emaSeries(c, 26), m = e12.map((x, i) => x - e26[i]);
  const s = emaSeries(m, 9), mm = m[m.length - 1], h = mm - s[s.length - 1];
  return mm > 0 && h > 0 ? 2 : mm < 0 && h < 0 ? -2 : h > 0 ? 1 : -1;
}
const rsiScore = (r) => r == null ? 0 : r > 60 ? 2 : r > 52 ? 1 : r < 40 ? -2 : r < 48 ? -1 : 0;
const clamp = (x) => Math.max(-2, Math.min(2, x));

// ---------- data ----------
async function chart(sym, interval, range) {
  const j = await (await get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=${interval}&range=${range}`)).json();
  const r = j.chart.result[0];
  return { close: r.indicators.quote[0].close.filter((x) => x != null), price: r.meta.regularMarketPrice, prev: r.meta.chartPreviousClose };
}
async function getTech(p) {
  const sym = PAIRS[p][0];
  const [d, h] = await Promise.all([chart(sym, "1d", "1y"), chart(sym, "1h", "1mo")]);
  const r = rsi(d.close);
  return { price: d.price, chg: d.prev ? ((d.price - d.prev) / d.prev) * 100 : 0, rsi: r,
    f: { d1: trend(d.close), h1: trend(h.close), rsi: rsiScore(r), macd: macdScore(d.close) } };
}
async function getCot() {
  const names = Object.values(COT_NAMES).map((n) => `'${n}'`).join(",");
  const u = "https://publicreporting.cftc.gov/resource/6dca-aqww.json?$limit=400&$order=report_date_as_yyyy_mm_dd DESC&$where=" +
    encodeURIComponent(`contract_market_name in(${names})`);
  const rows = await (await get(u)).json(); const out = {};
  for (const [cur, nm] of Object.entries(COT_NAMES)) {
    const r = rows.filter((x) => x.contract_market_name === nm).slice(0, 2); if (!r.length) continue;
    const net = (x) => +x.noncomm_positions_long_all - +x.noncomm_positions_short_all;
    const tot = (x) => +x.noncomm_positions_long_all + +x.noncomm_positions_short_all;
    out[cur] = { date: r[0].report_date_as_yyyy_mm_dd.slice(0, 10), long: +r[0].noncomm_positions_long_all,
      short: +r[0].noncomm_positions_short_all, net: net(r[0]), change: r[1] ? net(r[0]) - net(r[1]) : 0,
      ratio: tot(r[0]) ? net(r[0]) / tot(r[0]) : 0 };
  }
  return out;
}
const unesc = (s) => s.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/&amp;/g, "&").replace(/&#039;|&#39;/g, "'").replace(/&quot;/g, '"').trim();
async function getNews() {
  const all = await Promise.all(FEEDS.map(async ([src, u]) => {
    try {
      const x = await (await get(u)).text(); const items = [];
      for (const m of x.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
        const t = (tag) => { const r = m[1].match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)); return r ? unesc(r[1]) : ""; };
        items.push({ src, title: t("title"), link: t("link"), time: new Date(t("pubDate")).getTime() || 0 });
      }
      return items;
    } catch (e) { return []; }
  }));
  return all.flat().sort((a, b) => b.time - a.time).slice(0, 60);
}
async function getCalendar() {
  const j = await (await get("https://nfs.faireconomy.media/ff_calendar_thisweek.json")).json();
  return j.filter((e) => e.impact === "High" || e.impact === "Medium").map((e) => ({ ...e, time: new Date(e.date).getTime() }));
}
async function getFred() {
  if (!FRED) return null;
  const S = { "Fed Funds Rate %": "FEDFUNDS", "US CPI (YoY %)": "CPIAUCSL", "US Unemployment %": "UNRATE", "US Nonfarm Payrolls (ماہانہ تبدیلی, ہزار)": "PAYEMS", "US GDP growth (QoQ ann. %)": "A191RL1Q225SBEA" };
  const out = [];
  for (const [label, id] of Object.entries(S)) {
    const j = await (await get(`https://api.stlouisfed.org/fred/series/observations?series_id=${id}&api_key=${FRED}&file_type=json&sort_order=desc&limit=14`)).json();
    const v = j.observations.filter((o) => o.value !== ".").map((o) => +o.value); if (!v.length) continue;
    let val = v[0], prev = v[1];
    if (id === "CPIAUCSL" && v.length >= 13) { val = (v[0] / v[12] - 1) * 100; prev = (v[1] / v[13] - 1) * 100; }
    if (id === "PAYEMS") { val = v[0] - v[1]; prev = v[1] - v[2]; }
    out.push({ label, val: +val.toFixed(2), prev: +prev.toFixed(2), date: j.observations[0].date });
  }
  return out;
}

function build(tech, cot) {
  const res = {};
  for (const [p, [, b, q]] of Object.entries(PAIRS)) {
    const t = tech[p]; if (!t) continue;
    const f = { ...t.f };
    const rb = cot[b] ? cot[b].ratio : null, rq = q && cot[q] ? cot[q].ratio : null;
    if (rb != null && (q === null ? true : rq != null)) f.cot = clamp(Math.round((rb - (rq || 0)) * 4));
    let s = 0, m = 0; for (const k in f) { s += f[k] * WEIGHTS[k]; m += 2 * WEIGHTS[k]; }
    const score = Math.round(50 + (50 * s) / m);
    res[p] = { price: t.price, chg: t.chg, rsi: t.rsi, factors: f, score };
  }
  return res;
}
async function snapshot() {
  const [techs, cot, news, calendar, fred] = await Promise.all([
    Promise.all(Object.keys(PAIRS).map(async (p) => [p, await cached("t:" + p, 5 * 60e3, () => getTech(p), null)])),
    cached("cot", 6 * 3600e3, getCot, {}), cached("news", 3 * 60e3, getNews, []),
    cached("cal", 20 * 60e3, getCalendar, []), cached("fred", 6 * 3600e3, getFred, null),
  ]);
  return { updated: Date.now(), pairs: build(Object.fromEntries(techs), cot || {}), cot, news, calendar, fred, hasFred: !!FRED };
}

http.createServer(async (req, res) => {
  if (req.url.startsWith("/api/data")) {
    const d = await snapshot();
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); return res.end(JSON.stringify(d));
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(fs.readFileSync(path.join(__dirname, "index.html")));
}).listen(PORT, () => console.log("Trader Hub چل رہا ہے: http://localhost:" + PORT));
