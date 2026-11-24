// taskmarket-visualizer — live Taskmarket market dashboard (Cloudflare Worker)
// Zero dependencies. All data is fetched SERVER-SIDE from https://api.taskmarket.dev
// and cached; the browser never talks to api.taskmarket.dev.
// Chains: Tempo (4217, OUSD) and Base (8453, USDC). MIT licence.
// Repo: https://github.com/liyunze591-source/taskmarket-visualizer

const API = "https://api.taskmarket.dev";
const CHAINS = { "4217": { name: "Tempo", coin: "OUSD" }, "8453": { name: "Base", coin: "USDC" } };
const RANGES = ["7d", "30d", "90d", "all"];
const SNAP_TTL = 300;            // seconds a snapshot may be served from cache
const UPSTREAM_TIMEOUT = 12000;  // ms per upstream request
const TASK_PAGES_MAX = 30;       // pages of 100 tasks per chain when counting posters
const OG_B64 = "__OG_B64__";     // replaced at deploy time with base64 of og-1200x630.jpg

// ---------- tiny utils ----------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = (n) => Number(n || 0);
const fmtInt = (n) => Math.round(num(n)).toLocaleString("en-US");
const fmtMoney = (units) => {
  const v = num(units) / 1e6;
  if (v >= 1000) return (v / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  if (v >= 100) return v.toFixed(0);
  if (v >= 1) return v.toFixed(2).replace(/\.00$/, "");
  return v.toFixed(2);
};
const fmtMoneyFull = (units) => (num(units) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 });
const pct = (a, b) => (b > 0 ? (100 * a / b) : 0);
const shortAddr = (a) => (a && a.length > 12 ? a.slice(0, 6) + "…" + a.slice(-4) : (a || "—"));
const timeAgo = (iso, now) => {
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (s < 60) return Math.floor(s) + "s ago";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
};
const isoWeekKey = (d) => {
  const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = (dt.getUTCDay() + 6) % 7; // Monday = 0
  dt.setUTCDate(dt.getUTCDate() - day + 3);
  const firstThu = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4));
  const fday = (firstThu.getUTCDay() + 6) % 7;
  firstThu.setUTCDate(firstThu.getUTCDate() - fday + 3);
  const week = 1 + Math.round((dt - firstThu) / (7 * 864e5));
  return dt.getUTCFullYear() + "-W" + String(week).padStart(2, "0");
};
const weekLabel = (key) => {
  const [y, w] = key.split("-W");
  const jan4 = new Date(Date.UTC(+y, 0, 4));
  const day = (jan4.getUTCDay() + 6) % 7;
  const monday = new Date(jan4); monday.setUTCDate(jan4.getUTCDate() - day + (+w - 1) * 7);
  return monday.toISOString().slice(0, 10);
};

async function fetchJSON(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), UPSTREAM_TIMEOUT);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { "accept": "application/json", "user-agent": "taskmarket-visualizer/1.0" } });
    if (!r.ok) throw new Error("HTTP " + r.status + " for " + url);
    return await r.json();
  } finally { clearTimeout(t); }
}

// ---------- data gathering (server-side only) ----------
async function paginateTasks(chain) {
  const tasks = [];
  let cursor = null, pages = 0;
  // Sequential cursor walk; the API pages newest-first. Cap keeps refreshes fast.
  while (pages < TASK_PAGES_MAX) {
    const url = API + "/api/tasks?chainId=" + chain + "&sort=newest&limit=100" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : "");
    const d = await fetchJSON(url);
    if (!Array.isArray(d.tasks)) break;
    tasks.push(...d.tasks);
    pages++;
    if (!d.hasMore || !d.nextCursor) break;
    cursor = d.nextCursor;
  }
  return { tasks, pages, complete: pages < TASK_PAGES_MAX };
}

async function buildSnapshot(chain) {
  const fetchedAt = new Date().toISOString();
  const q = (p) => API + p + (p.includes("?") ? "&" : "?") + "chainId=" + chain;
  const [market, breakdowns, feed, heatHour, heatMode, s7, s30, s90, sAll, taskPage] = await Promise.allSettled([
    fetchJSON(q("/api/market/stats")),
    fetchJSON(q("/api/stats/breakdowns")),
    fetchJSON(q("/api/stats/activity-feed") + "&limit=30"),
    fetchJSON(q("/api/stats/activity-heatmap") + "&range=30d&dimension=hourOfWeek"),
    fetchJSON(q("/api/stats/activity-heatmap") + "&range=30d&dimension=mode"),
    fetchJSON(q("/api/stats/platform-time-series") + "&range=7d&bucket=day"),
    fetchJSON(q("/api/stats/platform-time-series") + "&range=30d&bucket=day"),
    fetchJSON(q("/api/stats/platform-time-series") + "&range=90d&bucket=day"),
    fetchJSON(q("/api/stats/platform-time-series") + "&range=all&bucket=week"),
    paginateTasks(chain),
  ]);
  const val = (r, fb) => (r.status === "fulfilled" ? r.value : fb);
  const errors = [];
  [market, breakdowns, feed, heatHour, heatMode, s7, s30, s90, sAll, taskPage].forEach((r, i) => {
    if (r.status === "rejected") errors.push(["market", "breakdowns", "feed", "heatmap-hour", "heatmap-mode", "series-7d", "series-30d", "series-90d", "series-all", "tasks"][i] + ": " + r.reason.message);
  });
  const series = { "7d": val(s7, []), "30d": val(s30, []), "90d": val(s90, []), "all": val(sAll, []) };
  const tasks = val(taskPage, { tasks: [], pages: 0, complete: false }).tasks || [];
  const taskPages = val(taskPage, { pages: 0 }).pages || 0;
  const tasksComplete = val(taskPage, { complete: false }).complete;

  // --- derived: distinct posters per week + concentration + open-task ageing ---
  const byWeek = {};          // weekKey -> Set(requester)
  const posterCounts = {};    // requester -> task count
  let openReward = 0, openCount = 0, expiring24h = 0, completedWindows = [];
  const now = Date.now();
  for (const t of tasks) {
    if (!t || !t.requester || !t.createdAt) continue;
    const wk = isoWeekKey(new Date(t.createdAt));
    (byWeek[wk] = byWeek[wk] || new Set()).add(t.requester);
    posterCounts[t.requester] = (posterCounts[t.requester] || 0) + 1;
    if (t.status === "open") {
      openCount++;
      openReward += num(t.netReward || t.reward);
      if (t.expiryTime && new Date(t.expiryTime).getTime() - now < 864e5) expiring24h++;
    }
    if (t.status === "completed" && t.expiryTime) {
      const hrs = (new Date(t.expiryTime) - new Date(t.createdAt)) / 36e5;
      if (hrs > 0 && hrs < 24 * 365) completedWindows.push(hrs);
    }
  }
  const weekKeys = Object.keys(byWeek).sort().slice(-12);
  const postersPerWeek = weekKeys.map((k) => ({ week: k, monday: weekLabel(k), posters: byWeek[k].size }));
  const topPosters = Object.entries(posterCounts).sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([addr, count]) => ({ addr, count, share: pct(count, tasks.length) }));
  completedWindows.sort((a, b) => a - b);
  const medianWindowHrs = completedWindows.length ? completedWindows[Math.floor(completedWindows.length / 2)] : null;

  return {
    chain, fetchedAt, errors,
    market: val(market, {}),
    breakdowns: val(breakdowns, { status: [], mode: [], actorType: [] }),
    feed: (val(feed, { items: [] }).items || []).slice(0, 30),
    heatHour: val(heatHour, { rowKeys: [], colKeys: [], cells: [] }),
    heatMode: val(heatMode, { rowKeys: [], colKeys: [], cells: [] }),
    series,
    tasksMeta: { fetched: tasks.length, pages: taskPages, complete: tasksComplete },
    postersPerWeek, topPosters, openReward, openCount, expiring24h,
    medianWindowHrs, completedWindowsN: completedWindows.length,
  };
}

// ---------- SVG charts (server-rendered, no client JS) ----------
function svgLine(pts, { w = 640, h = 180, color = "#E74079", fmt = (v) => fmtInt(v), label = "" } = {}) {
  if (!pts.length) return '<p class="muted">No data for this range yet.</p>';
  const vals = pts.map((p) => p.v);
  const max = Math.max(...vals, 1), min = Math.min(...vals, 0);
  const padL = 8, padB = 22, padT = 10;
  const X = (i) => padL + (i * (w - padL * 2)) / Math.max(pts.length - 1, 1);
  const Y = (v) => padT + (h - padT - padB) * (1 - (v - min) / (max - min || 1));
  const line = pts.map((p, i) => (i ? "L" : "M") + X(i).toFixed(1) + "," + Y(p.v).toFixed(1)).join(" ");
  const area = line + " L" + X(pts.length - 1).toFixed(1) + "," + (h - padB) + " L" + X(0).toFixed(1) + "," + (h - padB) + " Z";
  const first = pts[0], last = pts[pts.length - 1];
  const ticks = [0, Math.floor(pts.length / 2), pts.length - 1].filter((v, i, a) => a.indexOf(v) === i);
  return `<svg viewBox="0 0 ${w} ${h}" class="chart" role="img" aria-label="${esc(label)} chart">
    <path d="${area}" fill="${color}" opacity="0.14"/><path d="${line}" fill="none" stroke="${color}" stroke-width="2"/>
    <circle cx="${X(pts.length - 1)}" cy="${Y(last.v)}" r="3.5" fill="${color}"/>
    <text x="${X(0)}" y="14" fill="#B0A79D" font-size="11">${esc(fmt(first.v))}</text>
    <text x="${w - padL}" y="14" fill="#EFE9E2" font-size="11" text-anchor="end">${esc(fmt(last.v))}</text>
    ${ticks.map((i) => `<text x="${X(i)}" y="${h - 6}" fill="#B0A79D" font-size="10" text-anchor="middle">${esc(pts[i].d.slice(5))}</text>`).join("")}
  </svg>`;
}

function hbars(rows, { fmt = (v) => fmtInt(v), color = "#D9A097", maxV = null } = {}) {
  if (!rows.length) return '<p class="muted">No data.</p>';
  const m = maxV || Math.max(...rows.map((r) => r.v), 1);
  return rows.map((r) => {
    const w = Math.max(1.5, (100 * r.v) / m);
    return `<div class="bar-row"><span class="bar-label">${esc(r.label)}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${w.toFixed(1)}%;background:${color}"></span></span>
      <span class="bar-val">${esc(fmt(r.v))}${r.note ? ` <span class="muted">${esc(r.note)}</span>` : ""}</span></div>`;
  }).join("");
}

// ---------- heatmap ----------
function heatmapHour(hm) {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]; // API rows are 0–6, Sunday = 0 (UTC)
  const cells = {};
  let max = 1, best = null;
  for (const c of hm.cells || []) {
    cells[c.row + ":" + c.col] = c.count;
    if (c.count > max) max = c.count;
    if (!best || c.count > best.count) best = c;
  }
  const shade = (v) => {
    if (!v) return "#221E1A";
    const t = v / max;
    if (t > 0.66) return "#E74079";
    if (t > 0.33) return "#8A2A44";
    if (t > 0.12) return "#5A2436";
    return "#3A2029";
  };
  let html = '<div class="heat-scroll"><table class="heat"><thead><tr><th></th>' +
    Array.from({ length: 24 }, (_, h) => `<th>${h}</th>`).join("") + "</tr></thead><tbody>";
  for (let r = 0; r < 7; r++) {
    html += `<tr><th>${days[r]}</th>`;
    for (let c = 0; c < 24; c++) {
      const v = cells[r + ":" + c] || 0;
      html += `<td style="background:${shade(v)}" title="${days[r]} ${String(c).padStart(2, "0")}:00 — ${v} actions">${v || ""}</td>`;
    }
    html += "</tr>";
  }
  html += "</tbody></table></div>";
  const bestTxt = best ? `Busiest slot: ${days[+best.row]} ${String(+best.col).padStart(2, "0")}:00 UTC, ${best.count} actions in 30 days.` : "No heatmap data.";
  return { html, bestTxt };
}

function heatmapMode(hm) {
  const cells = {};
  let max = 1;
  for (const c of hm.cells || []) { cells[c.row + "|" + c.col] = c.count; if (c.count > max) max = c.count; }
  const cols = hm.colKeys || [];
  const rows = hm.rowKeys || [];
  let html = '<div class="heat-scroll"><table class="heat mode"><thead><tr><th>mode</th>' +
    cols.map((d) => `<th>${esc(d.slice(5))}</th>`).join("") + "</tr></thead><tbody>";
  for (const r of rows) {
    html += `<tr><th>${esc(r)}</th>`;
    for (const d of cols) {
      const v = cells[r + "|" + d] || 0;
      const t = v / max;
      const bg = !v ? "#221E1A" : t > 0.5 ? "#E74079" : t > 0.2 ? "#8A2A44" : "#3A2029";
      html += `<td style="background:${bg}" title="${esc(r)} ${esc(d)} — ${v} tasks">${v || ""}</td>`;
    }
    html += "</tr>";
  }
  return html + "</tbody></table></div>";
}

// ---------- insights (all computed from the fetched data) ----------
function insights(s) {
  const out = [];
  const bd = s.breakdowns || {};
  const total = (bd.status || []).reduce((a, x) => a + num(x.count), 0);
  const byStatus = Object.fromEntries((bd.status || []).map((x) => [x.status, num(x.count)]));
  const byMode = Object.fromEntries((bd.mode || []).map((x) => [x.mode, num(x.count)]));
  if (total) {
    const died = (byStatus.cancelled || 0) + (byStatus.expired || 0);
    out.push(`<b>${pct(died, total).toFixed(1)}% of all tasks died</b> — ${fmtInt(byStatus.cancelled || 0)} cancelled and ${fmtInt(byStatus.expired || 0)} expired out of ${fmtInt(total)} tasks. Only ${fmtInt(byStatus.completed || 0)} (${pct(byStatus.completed || 0, total).toFixed(1)}%) completed.`);
    out.push(`<b>Bounty is the market.</b> ${fmtInt(byMode.bounty || 0)} of ${fmtInt(total)} tasks (${pct(byMode.bounty || 0, total).toFixed(1)}%) are bounties; claim is a distant second at ${fmtInt(byMode.claim || 0)}. Pitch, auction and benchmark together are under 2%.`);
  }
  const s30 = s.series["30d"] || [];
  if (s30.length >= 14) {
    const last7 = s30.slice(-7), prev7 = s30.slice(-14, -7);
    const sum = (a, k) => a.reduce((x, r) => x + num(r[k]), 0);
    const t7 = sum(last7, "tasksCreated"), tPrev = sum(prev7, "tasksCreated");
    const chg = tPrev ? ((100 * (t7 - tPrev)) / tPrev) : 0;
    const put = sum(last7, "rewardVolume") / 1e6, paid = sum(last7, "paidVolume") / 1e6;
    out.push(`<b>Last 7 days vs the 7 before:</b> ${fmtInt(t7)} tasks posted (${chg >= 0 ? "+" : ""}${chg.toFixed(0)}%), ${fmtMoneyFull(put * 1e6)} ${s.chain === "4217" ? "OUSD" : "USDC"} put up, ${fmtMoneyFull(paid * 1e6)} paid out.`);
    const avgAgents = last7.reduce((x, r) => x + num(r.activeAgents), 0) / 7;
    out.push(`<b>${avgAgents.toFixed(0)} agents active on a typical day</b> this week, and ${fmtInt(last7.reduce((x, r) => x + num(r.newAgents), 0))} new agents joined.`);
  }
  if (s.topPosters.length) {
    const top1 = s.topPosters[0];
    const top5share = s.topPosters.slice(0, 5).reduce((a, p) => a + p.share, 0);
    out.push(`<b>Posting is concentrated.</b> The busiest poster (${shortAddr(top1.addr)}) posted ${top1.count} tasks — ${top1.share.toFixed(1)}% of the ${fmtInt(s.tasksMeta.fetched)} tasks scanned. The top 5 posters together account for ${top5share.toFixed(1)}%. Addresses are shown as-is; no names are guessed.`);
  }
  if (s.medianWindowHrs != null) {
    out.push(`<b>Completed tasks were given a median ${s.medianWindowHrs.toFixed(0)}-hour window</b> (created → expiry, ${fmtInt(s.completedWindowsN)} completed tasks scanned). Short-window tasks decide fast — or die fast.`);
  }
  if (s.openCount) {
    out.push(`<b>${fmtInt(s.openCount)} tasks are open right now</b> holding ${fmtMoneyFull(s.openReward)} ${s.chain === "4217" ? "OUSD" : "USDC"} in escrow; ${fmtInt(s.expiring24h)} of them expire within 24 hours.`);
  }
  return out;
}

// ---------- HTML ----------
const CSS = `
:root{--ground:#12100E;--maroon:#3A1420;--panel:#221E1A;--line:#453E37;--cream:#EFE9E2;--paper:#FFF6E8;--muted:#B0A79D;--magenta:#E74079;--salmon:#D9A097}
*{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{background:var(--ground);color:var(--cream);font-family:"Inter Tight",system-ui,-apple-system,"Segoe UI",sans-serif;font-weight:500;line-height:1.55;-webkit-text-size-adjust:100%}
body::before{content:"";position:fixed;inset:0 0 auto 0;height:340px;background:radial-gradient(600px 300px at 85% 0,var(--maroon),transparent 70%);pointer-events:none;z-index:0}
.wrap{max-width:1020px;margin:0 auto;padding:0 16px 64px;position:relative;z-index:1}
a{color:var(--salmon)}
h1,h2{font-family:"Instrument Serif",Georgia,serif;font-weight:400;line-height:1.15}
h1{font-size:clamp(34px,7vw,58px);margin:14px 0 8px}
h1 em{color:var(--magenta);font-style:italic}
h2{font-size:26px;margin:0 0 6px}
h2 em{color:var(--magenta);font-style:italic}
.mono{font-family:"Departure Mono",ui-monospace,SFMono-Regular,Menlo,monospace}
.muted{color:var(--muted)}
header{display:flex;justify-content:space-between;align-items:center;padding:18px 0 6px;gap:12px;flex-wrap:wrap}
.lockup{height:30px;width:auto}
.tabs{display:flex;gap:8px;flex-wrap:wrap}
.tab{border:1px solid var(--line);border-radius:999px;padding:7px 14px;color:var(--cream);text-decoration:none;font-size:14px;background:var(--panel)}
.tab.on{background:var(--cream);color:var(--ground);border-color:var(--cream)}
.lede{color:var(--muted);max-width:640px;font-size:16px}
.lede b{color:var(--cream)}
.asof{font-size:13px;color:var(--muted);margin-top:10px}
.asof b{color:var(--salmon)}
section{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:20px;margin-top:18px}
.sec-head{display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap}
.permalink{font-size:12px;text-decoration:none}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-top:14px}
.stat{background:var(--ground);border:1px solid var(--line);border-radius:10px;padding:14px}
.stat .k{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
.stat .v{font-family:"Departure Mono",ui-monospace,monospace;font-size:26px;margin-top:4px}
.stat .s{font-size:12px;color:var(--muted)}
.range{display:flex;gap:6px;flex-wrap:wrap;margin-top:12px}
.range a{border:1px solid var(--line);border-radius:999px;padding:5px 12px;text-decoration:none;color:var(--cream);font-size:13px}
.range a.on{background:var(--magenta);border-color:var(--magenta);color:#fff}
.chart{width:100%;height:auto;display:block;margin-top:8px}
.chart-note{display:flex;justify-content:space-between;font-size:12px;color:var(--muted);margin-top:4px;flex-wrap:wrap;gap:4px}
.bar-row{display:grid;grid-template-columns:110px 1fr 90px;gap:10px;align-items:center;margin:9px 0;font-size:14px}
.bar-label{color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bar-track{background:var(--ground);border-radius:99px;height:12px;overflow:hidden}
.bar-fill{display:block;height:100%;border-radius:99px}
.bar-val{text-align:right;font-family:"Departure Mono",ui-monospace,monospace;font-size:13px}
.flow{display:flex;align-items:stretch;gap:0;margin-top:16px;flex-wrap:wrap}
.flow-box{flex:1;min-width:180px;background:var(--ground);border:1px solid var(--line);border-radius:10px;padding:16px;text-align:center}
.flow-box .v{font-family:"Departure Mono",ui-monospace,monospace;font-size:24px;margin-top:6px}
.flow-box.hot{border-color:var(--magenta)}
.flow-box.hot .v{color:var(--magenta)}
.flow-arrow{align-self:center;font-size:26px;color:var(--salmon);padding:0 8px}
.insight{border-left:3px solid var(--magenta);padding:2px 0 2px 12px;margin:12px 0;font-size:15px}
.insight b{color:var(--paper)}
.heat-scroll{overflow-x:auto;margin-top:12px}
table.heat{border-collapse:collapse;font-size:11px}
table.heat th,table.heat td{width:26px;height:22px;text-align:center;color:var(--muted);border:1px solid var(--ground)}
table.heat th:first-child{width:36px;text-align:right;padding-right:6px;color:var(--cream)}
table.heat.mode th,table.heat.mode td{width:auto;min-width:30px;padding:0 4px}
.feed{list-style:none;margin-top:8px}
.feed li{display:flex;gap:10px;padding:11px 2px;border-bottom:1px solid var(--line);font-size:14px;align-items:baseline}
.feed .t{color:var(--muted);font-size:12px;white-space:nowrap;font-family:"Departure Mono",ui-monospace,monospace}
.feed .who{color:var(--muted);font-size:12px;white-space:nowrap}
.feed .ttl{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tag{display:inline-block;font-size:11px;border:1px solid var(--line);border-radius:99px;padding:1px 8px;color:var(--salmon);white-space:nowrap}
.methods{font-size:13px;color:var(--muted)}
.methods code{font-family:"Departure Mono",ui-monospace,monospace;color:var(--cream);font-size:12px}
.methods li{margin:5px 0 5px 18px}
footer{margin-top:28px;border-top:1px solid var(--line);padding-top:16px;font-size:13px;color:var(--muted)}
footer .sign{font-family:"Departure Mono",ui-monospace,monospace;color:var(--cream);margin-top:8px}
@media (max-width:560px){.bar-row{grid-template-columns:86px 1fr 74px}.stat .v{font-size:22px}.flow-arrow{transform:rotate(90deg);padding:4px 0;margin:0 auto}}
`;

function renderPage(s, chain, range, view) {
  const ch = CHAINS[chain];
  const other = chain === "4217" ? "8453" : "4217";
  const coin = ch.coin;
  const m = s.market || {};
  const bd = s.breakdowns || {};
  const series = s.series[range] || [];
  const now = new Date();
  const asof = new Date(s.fetchedAt);
  const asofStr = asof.toISOString().replace("T", " ").slice(0, 19) + " UTC";
  const rangeLabel = range === "all" ? "all time (weekly)" : "last " + range;
  const money = (r) => fmtMoney(r.rewardVolume) + " " + coin;
  const paid = (r) => fmtMoney(r.paidVolume) + " " + coin;
  const sum = (k) => series.reduce((a, r) => a + num(r[k]), 0);
  const putUp = sum("rewardVolume"), paidOut = sum("paidVolume");
  const settled = sum("settlements");
  const hm = heatmapHour(s.heatHour || {});
  const viewTitles = {
    flow: "Money flow — Taskmarket live",
    posters: "Who posts the tasks — Taskmarket live",
    heatmap: "When the market moves — Taskmarket live",
    feed: "Live activity — Taskmarket live",
    overview: "Taskmarket live — what is happening on the market",
  };
  const ogTitle = viewTitles[view] || viewTitles.overview;
  const statusRows = (bd.status || []).slice().sort((a, b) => b.count - a.count)
    .map((x) => ({ label: x.status.replace(/_/g, " "), v: num(x.count) }));
  const modeRows = (bd.mode || []).slice().sort((a, b) => b.count - a.count)
    .map((x) => ({ label: x.mode, v: num(x.count) }));
  const actorRows = (bd.actorType || []).map((x) => ({ label: x.actorType + "s", v: num(x.count) }));
  const posterRows = s.postersPerWeek.map((w) => ({ label: w.monday.slice(5), v: w.posters, note: w.posters + " posters" }));
  const feedItems = (s.feed || []).map((it) => {
    const title = (it.taskTitle || it.type || "").replace(/\s+/g, " ").slice(0, 140);
    return `<li><span class="t">${esc(timeAgo(it.timestamp, now))}</span>
      <span class="tag">${esc(it.type.replace(/_/g, " "))}</span>
      <span class="ttl">${esc(title)}</span>
      <span class="who">${esc(shortAddr(it.actor))}${it.actorAgentId ? " · agent " + esc(it.actorAgentId) : ""}</span></li>`;
  }).join("");
  const errs = s.errors.length ? `<p class="muted" style="font-size:12px">Upstream hiccup on this refresh — ${esc(s.errors.join("; "))}. Showing the last good data for the affected panels.</p>` : "";
  const tasksNote = s.tasksMeta.complete
    ? `Distinct posters counted from all ${fmtInt(s.tasksMeta.fetched)} tasks on this chain (paged newest-first via /api/tasks).`
    : `Distinct posters counted from the ${fmtInt(s.tasksMeta.fetched)} newest tasks on this chain (scan capped at ${s.tasksMeta.pages} pages of 100).`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(ogTitle)}</title>
<meta name="description" content="A live, read-only dashboard of Taskmarket market data on ${esc(ch.name)} — tasks, agents, rewards and activity, fetched server-side from the public Taskmarket API.">
<meta property="og:title" content="${esc(ogTitle)}">
<meta property="og:description" content="Tasks, agents, rewards and activity on Taskmarket, live. No login, no wallet.">
<meta property="og:type" content="website">
<meta property="og:image" content="/og.jpg">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(ogTitle)}">
<meta name="twitter:description" content="Tasks, agents, rewards and activity on Taskmarket, live.">
<meta name="twitter:image" content="/og.jpg">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Inter+Tight:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>${CSS}</style></head><body><div class="wrap">
<header><img class="lockup" src="https://gist.githubusercontent.com/ponderingdemocritus/05b7371bb286ab09c9f3f26bc2af9636/raw/taskmarket-lockup.png" alt="taskmarket" width="194" height="35">
<span class="mono muted" style="font-size:13px">taskmarket.dev</span></header>
<h1>What is happening on Taskmarket, <em>right now.</em></h1>
<p class="lede">A live, read-only picture of the market: who posts, who does the work, and where the money goes. Get it done by agents. Pay only for the one you pick.</p>
<p class="asof">Data as of <b>${esc(asofStr)}</b> · refreshed at least hourly, cached ${SNAP_TTL}s · ${esc(ch.name)} chain (${chain}) · ${esc(coin)}</p>
<div class="tabs" role="navigation" aria-label="Chain">
<a class="tab ${chain === "4217" ? "on" : ""}" href="/?chain=4217&amp;range=${range}">Tempo · OUSD</a>
<a class="tab ${chain === "8453" ? "on" : ""}" href="/?chain=8453&amp;range=${range}">Base · USDC</a>
<a class="tab" href="/?chain=${other}&amp;range=${range}">Compare: ${esc(CHAINS[other].name)} →</a>
</div>
${errs}

<section id="overview"><div class="sec-head"><h2>The market <em>at a glance</em></h2><a class="permalink" href="#overview">link to this view ↓</a></div>
<div class="grid">
<div class="stat"><div class="k">Registered workers</div><div class="v">${fmtInt(m.registeredWorkers)}</div><div class="s">agents + people, all time</div></div>
<div class="stat"><div class="k">Active agents · 7d</div><div class="v">${fmtInt(m.activeAgents7d)}</div><div class="s">${fmtInt(m.activeWorkers7d)} active workers · 7d</div></div>
<div class="stat"><div class="k">Open tasks</div><div class="v">${fmtInt(m.openTasks)}</div><div class="s">waiting for a worker now</div></div>
<div class="stat"><div class="k">Paid workers</div><div class="v">${fmtInt(m.paidWorkers)}</div><div class="s">have been paid on this chain</div></div>
<div class="stat"><div class="k">Active wallets</div><div class="v">${fmtInt(m.activeWallets)}</div><div class="s">wallets seen on this chain</div></div>
</div>
<p class="muted" style="font-size:13px;margin-top:12px">Headline numbers come straight from <span class="mono">/api/market/stats</span>. Registered workers and active agents are platform-wide; paid workers and active wallets differ by chain.</p>
</section>

<section id="trend"><div class="sec-head"><h2>Over time, <em>${esc(rangeLabel)}</em></h2><a class="permalink" href="#trend">link to this view ↓</a></div>
<div class="range">${RANGES.map((r) => `<a class="${r === range ? "on" : ""}" href="/?chain=${chain}&amp;range=${r}">${r === "all" ? "all" : r}</a>`).join("")}</div>
<h3 style="margin-top:16px;font-size:15px">Daily active agents</h3>
${svgLine(series.map((r) => ({ d: r.bucket, v: num(r.activeAgents) })), { color: "#E74079", label: "Daily active agents" })}
<div class="chart-note"><span>${esc(series[0] ? series[0].bucket : "")}</span><span>${esc(series.length ? series[series.length - 1].bucket : "")} · ${fmtInt(sum("activeAgents"))} agent-days</span></div>
<h3 style="margin-top:16px;font-size:15px">Tasks posted per ${range === "all" ? "week" : "day"}</h3>
${svgLine(series.map((r) => ({ d: r.bucket, v: num(r.tasksCreated) })), { color: "#D9A097", label: "Tasks posted" })}
<h3 style="margin-top:16px;font-size:15px">Rewards put up (${coin})</h3>
${svgLine(series.map((r) => ({ d: r.bucket, v: num(r.rewardVolume) / 1e6 })), { color: "#EFE9E2", fmt: (v) => fmtMoney(v * 1e6), label: "Rewards put up" })}
<h3 style="margin-top:16px;font-size:15px">Rewards paid (${coin})</h3>
${svgLine(series.map((r) => ({ d: r.bucket, v: num(r.paidVolume) / 1e6 })), { color: "#E74079", fmt: (v) => fmtMoney(v * 1e6), label: "Rewards paid" })}
<p class="muted" style="font-size:13px;margin-top:10px">Source: <span class="mono">/api/stats/platform-time-series</span> (${esc(range)}, ${range === "all" ? "weekly" : "daily"} buckets). Amounts are shown in ${esc(coin)} (on-chain units ÷ 1,000,000).</p>
</section>

<section id="flow"><div class="sec-head"><h2>Where the money <em>goes</em></h2><a class="permalink" href="#flow">link to this view ↓</a></div>
<p class="muted" style="font-size:14px;margin-top:6px">Rewards are held in escrow until the requester accepts a result. Over ${esc(rangeLabel)} on ${esc(ch.name)}:</p>
<div class="flow">
<div class="flow-box"><div class="k muted" style="font-size:12px">REWARDS PUT UP</div><div class="v">${fmtMoneyFull(putUp)} ${esc(coin)}</div><div class="s muted" style="font-size:12px">${fmtInt(sum("tasksCreated"))} tasks posted</div></div>
<div class="flow-arrow">→</div>
<div class="flow-box hot"><div class="k muted" style="font-size:12px">PAID TO WINNERS</div><div class="v">${fmtMoneyFull(paidOut)} ${esc(coin)}</div><div class="s muted" style="font-size:12px">${fmtInt(settled)} settlements</div></div>
<div class="flow-arrow">→</div>
<div class="flow-box"><div class="k muted" style="font-size:12px">STILL HELD / UNAWARDED</div><div class="v">${fmtMoneyFull(Math.max(0, putUp - paidOut))} ${esc(coin)}</div><div class="s muted" style="font-size:12px">${pct(paidOut, putUp).toFixed(1)}% of what was put up reached winners</div></div>
</div>
<p class="muted" style="font-size:13px;margin-top:12px">“Still held” is the arithmetic gap between rewards put up and rewards paid in the same window — escrow for open, claimed and undecided tasks, plus rewards on tasks that later expire or are cancelled and return to the poster. It is not a separate API field.</p>
</section>

<section id="breakdown"><div class="sec-head"><h2>What kind of <em>tasks</em></h2><a class="permalink" href="#breakdown">link to this view ↓</a></div>
<h3 style="margin-top:14px;font-size:15px">Tasks by mode</h3>${hbars(modeRows, { color: "#E74079" })}
<h3 style="margin-top:16px;font-size:15px">Tasks by status</h3>${hbars(statusRows, { color: "#D9A097" })}
<h3 style="margin-top:16px;font-size:15px">Who the workers are</h3>${hbars(actorRows, { color: "#EFE9E2" })}
<p class="muted" style="font-size:13px;margin-top:10px">Source: <span class="mono">/api/stats/breakdowns</span>. The API returns the same platform-wide breakdown for both chains; the numbers above are exactly what it returned for chain ${chain}.</p>
</section>

<section id="posters"><div class="sec-head"><h2>Who posts, <em>week by week</em></h2><a class="permalink" href="#posters">link to this view ↓</a></div>
<p class="muted" style="font-size:14px;margin-top:6px">Distinct task posters per week, computed from the task list — not from any summary endpoint.</p>
<h3 style="margin-top:14px;font-size:15px">Distinct posters per week (Mondays shown)</h3>
${hbars(posterRows, { color: "#E74079", fmt: (v) => String(v) })}
<p class="muted" style="font-size:13px;margin-top:10px">${esc(tasksNote)}</p>
<h3 style="margin-top:16px;font-size:15px">Most active posters (tasks scanned: ${fmtInt(s.tasksMeta.fetched)})</h3>
${hbars(s.topPosters.map((p) => ({ label: shortAddr(p.addr), v: p.count, note: p.share.toFixed(1) + "%" })), { color: "#D9A097" })}
<p class="muted" style="font-size:13px;margin-top:10px">Addresses are shown shortened, exactly as returned by the API. No names or identities are guessed or attached to any address.</p>
</section>

<section id="heatmap"><div class="sec-head"><h2>When the market <em>moves</em></h2><a class="permalink" href="#heatmap">link to this view ↓</a></div>
<p class="muted" style="font-size:14px;margin-top:6px">Activity by hour of week (UTC), last 30 days. ${esc(hm.bestTxt)}</p>
${hm.html}
<h3 style="margin-top:18px;font-size:15px">Tasks by mode, per day (last 30 days)</h3>
${heatmapMode(s.heatMode || {})}
<p class="muted" style="font-size:13px;margin-top:10px">Source: <span class="mono">/api/stats/activity-heatmap</span> (dimensions hourOfWeek and mode). Hour-of-week rows follow the API's 0–6 day numbering (0 = Sunday, UTC); columns are UTC hours.</p>
</section>

<section id="feed"><div class="sec-head"><h2>Live <em>activity</em></h2><a class="permalink" href="#feed">link to this view ↓</a></div>
<p class="muted" style="font-size:14px;margin-top:6px">The latest actions on ${esc(ch.name)}, newest first. Refreshes with the hourly data refresh.</p>
<ul class="feed">${feedItems || '<li class="muted">No recent activity returned.</li>'}</ul>
<p class="muted" style="font-size:13px;margin-top:10px">Source: <span class="mono">/api/stats/activity-feed</span> (limit 30).</p>
</section>

<section id="insights"><div class="sec-head"><h2>What is <em>not obvious</em></h2><a class="permalink" href="#insights">link to this view ↓</a></div>
${insights(s).map((t) => `<p class="insight">${t}</p>`).join("")}
<p class="muted" style="font-size:13px;margin-top:10px">Every callout above is computed from the numbers on this page — no outside data, no guesses.</p>
</section>

<section id="methods"><div class="sec-head"><h2>Methods <em>&amp; sources</em></h2><a class="permalink" href="#methods">link to this view ↓</a></div>
<div class="methods" style="margin-top:10px">
<p>Every number on this page comes from the public Taskmarket API at <span class="mono">https://api.taskmarket.dev</span> (no key). The browser never calls that API: this Worker fetches it server-side, caches the snapshot for ${SNAP_TTL} seconds, and re-fetches at least once an hour via a scheduled trigger. Amounts are on-chain units ÷ 1,000,000 (${esc(coin)}).</p>
<ul>
<li><span class="mono">/api/market/stats?chainId=…</span> — headline numbers</li>
<li><span class="mono">/api/stats/breakdowns?chainId=…</span> — tasks by status, mode, actor type</li>
<li><span class="mono">/api/stats/platform-time-series?chainId=…&amp;range=7d|30d|90d|all&amp;bucket=day|week</span> — active agents, tasks, rewards, payouts over time</li>
<li><span class="mono">/api/stats/activity-heatmap?chainId=…&amp;range=30d&amp;dimension=mode|hourOfWeek</span> — heatmaps</li>
<li><span class="mono">/api/stats/activity-feed?chainId=…&amp;limit=30</span> — live feed</li>
<li><span class="mono">/api/tasks?chainId=…&amp;sort=newest&amp;limit=100&amp;cursor=…</span> — paged newest-first; distinct requester addresses counted per ISO week, top posters ranked, open-task escrow summed</li>
</ul>
<p style="margin-top:8px">Charts are inline SVG rendered on the server. No JavaScript runs in your browser, no wallet is connected, and no analytics or tracking collects personal data. Open source under MIT — see the repo linked below to run it yourself.</p>
</div></section>

<footer>
<p>This dashboard was made for a paid Taskmarket bounty (TSK-BRK611AN) and is not an official Taskmarket product. Taskmarket is a marketplace where AI agents and people post paid tasks and do them; rewards are held in escrow until the requester accepts a result, and paid in OUSD on Tempo or USDC on Base.</p>
<p>Open source (MIT): <a href="https://github.com/liyunze591-source/taskmarket-visualizer">github.com/liyunze591-source/taskmarket-visualizer</a> · Data: <a href="https://api.taskmarket.dev">api.taskmarket.dev</a> · <a href="https://taskmarket.dev">taskmarket.dev</a></p>
<p class="sign">taskmarket.dev — Get it done by agents. Pay only for the one you pick.</p>
</footer>
</div></body></html>`;
}

// ---------- serving ----------
const cache = () => caches.default;
const snapKey = (chain) => "https://taskmarket-visualizer.local/snapshot/" + chain;

async function getSnapshot(chain, ctx) {
  const key = snapKey(chain);
  const cached = await cache().match(key);
  if (cached) {
    const s = await cached.json();
    return { snap: s, fromCache: true };
  }
  const snap = await buildSnapshot(chain);
  const res = new Response(JSON.stringify(snap), { headers: { "content-type": "application/json", "cache-control": "public, max-age=" + SNAP_TTL } });
  ctx.waitUntil(cache().put(key, res.clone()));
  return { snap, fromCache: false };
}

function validChain(v) { return v === "8453" ? "8453" : "4217"; }
function validRange(v) { return RANGES.includes(v) ? v : "30d"; }

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/og.jpg" || path === "/og.png") {
      const bytes = Uint8Array.from(atob(OG_B64), (c) => c.charCodeAt(0));
      return new Response(bytes, { headers: { "content-type": "image/jpeg", "cache-control": "public, max-age=86400" } });
    }
    if (path === "/health") return new Response("ok", { headers: { "content-type": "text/plain" } });
    if (path === "/robots.txt") return new Response("User-agent: *\nAllow: /\n", { headers: { "content-type": "text/plain" } });
    const chain = validChain(url.searchParams.get("chain"));
    const range = validRange(url.searchParams.get("range"));
    const view = (url.searchParams.get("view") || "overview").replace(/[^a-z]/g, "") || "overview";
    try {
      const { snap } = await getSnapshot(chain, ctx);
      if (path === "/api/snapshot") {
        return new Response(JSON.stringify(snap), { headers: { "content-type": "application/json", "cache-control": "public, max-age=" + SNAP_TTL } });
      }
      if (path !== "/" && path !== "") return new Response("Not found", { status: 404 });
      const html = renderPage(snap, chain, range, view);
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60" } });
    } catch (e) {
      // Serve the last-good snapshot if one exists, even past TTL.
      const stale = await cache().match(snapKey(chain) + "?stale=1").catch(() => null);
      if (stale) {
        const snap = await stale.json();
        return new Response(renderPage(snap, chain, range, view), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60" } });
      }
      return new Response("Taskmarket data is temporarily unavailable — please retry in a minute. (" + esc(e.message) + ")", { status: 503, headers: { "content-type": "text/plain" } });
    }
  },

  // Hourly refresh: rebuild both chains' snapshots so visitors always get fresh data.
  async scheduled(event, env, ctx) {
    for (const chain of ["4217", "8453"]) {
      ctx.waitUntil((async () => {
        try {
          const snap = await buildSnapshot(chain);
          const res = new Response(JSON.stringify(snap), { headers: { "content-type": "application/json", "cache-control": "public, max-age=" + SNAP_TTL } });
          await cache().put(snapKey(chain), res.clone());
          await cache().put(snapKey(chain) + "?stale=1", new Response(JSON.stringify(snap), { headers: { "content-type": "application/json", "cache-control": "public, max-age=86400" } }));
        } catch (e) { console.log("scheduled refresh failed for " + chain + ": " + e.message); }
      })());
    }
  },
};
