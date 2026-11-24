// One-command deploy for taskmarket-visualizer (zero dependencies, Node 18+).
// Usage:
//   CLOUDFLARE_API_TOKEN=<token with Workers Scripts:Edit> \
//   CLOUDFLARE_ACCOUNT_ID=<account id> npm run deploy
// The token needs Workers Scripts:Edit (and Workers Scripts:Read) on the account.
// What it does:
//   1. Builds dist/worker.js from worker.js, embedding og-1200x630.jpg as base64.
//   2. PUTs the script to Cloudflare Workers as `taskmarket-visualizer`.
//   3. Sets an hourly cron trigger (minute 5) so the dashboard refreshes itself.
//   4. Enables the *.workers.dev subdomain and prints the live URL.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";

const WORKER_NAME = process.env.WORKER_NAME || "taskmarket-visualizer";
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!API_TOKEN || !ACCOUNT_ID) {
  console.error("Missing CLOUDFLARE_API_TOKEN and/or CLOUDFLARE_ACCOUNT_ID.\n"
    + "Create a token at https://dash.cloudflare.com/profile/api-tokens with the\n"
    + "\"Workers Scripts:Edit\" permission, then re-run:\n"
    + "  CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... npm run deploy");
  process.exit(1);
}

const ogB64 = existsSync("og-1200x630.jpg")
  ? readFileSync("og-1200x630.jpg").toString("base64")
  : readFileSync("og-1200x630.jpg.b64", "utf8").trim();
const src = readFileSync("worker.js", "utf8");
if (!src.includes("__OG_B64__")) { console.error("worker.js has no __OG_B64__ placeholder — refusing to deploy a stale bundle."); process.exit(1); }
const bundle = src.replace("__OG_B64__", ogB64);
mkdirSync("dist", { recursive: true });
writeFileSync("dist/worker.js", bundle);
console.log(`Bundle: ${bundle.length} bytes (worker.js + embedded OG image).`);

const base = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}`;
const headers = { Authorization: `Bearer ${API_TOKEN}` };

async function cf(path, { method = "GET", body, contentType } = {}) {
  const res = await fetch(base + path, { method, headers: { ...headers, ...(contentType ? { "Content-Type": contentType } : {}) }, body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) {
    throw new Error(`${method} ${path} -> HTTP ${res.status}: ${JSON.stringify(data.errors || data)}`);
  }
  return data.result;
}

const form = new FormData();
form.append("metadata", new Blob([JSON.stringify({ main_module: "worker.js", compatibility_date: "2025-01-01" })], { type: "application/json" }));
form.append("worker.js", new Blob([bundle], { type: "application/javascript+module" }), "worker.js");
const up = await cf(`/workers/scripts/${WORKER_NAME}`, { method: "PUT", body: form });
console.log(`Uploaded ${WORKER_NAME} (id ${up.id}, etag ${up.etag}).`);

await cf(`/workers/scripts/${WORKER_NAME}/schedules`, {
  method: "PUT", body: JSON.stringify([{ cron: "5 * * * *" }]), contentType: "application/json",
});
console.log("Cron trigger set: hourly at minute 5 (refreshes both chains).");

await cf(`/workers/scripts/${WORKER_NAME}/subdomain`, {
  method: "POST", body: JSON.stringify({ enabled: true }), contentType: "application/json",
});
console.log("workers.dev subdomain enabled.");
console.log(`\nLive at: https://${WORKER_NAME}.<your-subdomain>.workers.dev`);
console.log("Verify: curl -s -o /dev/null -w '%{http_code} %{time_total}s' that URL (expect 200, <3s).");
