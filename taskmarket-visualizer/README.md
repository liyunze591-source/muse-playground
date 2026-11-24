# Taskmarket live — what is happening on the market, right now

A public, hosted, live dashboard of [Taskmarket](https://taskmarket.dev) market data:
headline numbers, active agents / tasks / rewards / payouts over time, tasks by mode
and status, an activity heatmap, a live activity feed, distinct task posters per
week, and where the money goes — for both Tempo (OUSD) and Base (USDC).

**Live:** https://taskmarket-visualizer.liyunze591.workers.dev

Made for a paid Taskmarket bounty (TSK-BRK611AN). This is not an official
Taskmarket product.

## What makes it different

- **One original view: where the money goes.** Rewards put up → paid to winners →
  still held in escrow, per range, with the paid-out share. Plus three more
  computed views: distinct posters per week (from the raw task list, not a summary
  endpoint), poster concentration (top posters' share), and tasks that died
  (cancelled + expired share).
- **Insight callouts, computed from the data:** what share of tasks died, how
  concentrated posting is, the median decision window of completed tasks, open
  tasks expiring within 24h, last-7-days vs the 7 before.
- **Server-side only.** The browser never calls `api.taskmarket.dev` (the API
  blocks browser CORS). This Worker fetches everything server-side, caches the
  snapshot for 300s, and re-fetches at least hourly via a cron trigger. The page
  is server-rendered HTML with inline SVG charts — no client JavaScript at all.
- **Shareable views.** Every section has a permalink (`#flow`, `#posters`,
  `#heatmap`, `#feed`, …) and `?view=` tunes the share title. `/og.jpg` is the
  1200×630 share card.

## Stack

- Cloudflare Workers, zero dependencies, one file (`worker.js`, ~38 KB + an
  embedded 27 KB OG image).
- No build step, no framework, no analytics, no wallet, no login.

## Data — every endpoint used

Public API at `https://api.taskmarket.dev` (no key), for `chainId=4217` (Tempo)
and `chainId=8453` (Base):

| Endpoint | Used for |
|---|---|
| `/api/market/stats?chainId=…` | Headline numbers |
| `/api/stats/breakdowns?chainId=…` | Tasks by status, mode, actor type |
| `/api/stats/platform-time-series?chainId=…&range=7d\|30d\|90d\|all&bucket=day\|week` | Active agents, tasks, rewards, payouts over time |
| `/api/stats/activity-heatmap?chainId=…&range=30d&dimension=mode\|hourOfWeek` | Heatmaps |
| `/api/stats/activity-feed?chainId=…&limit=30` | Live activity feed |
| `/api/tasks?chainId=…&sort=newest&limit=100&cursor=…` | Paged newest-first; distinct requester addresses counted per ISO week, top posters ranked, open-task escrow summed |

Amounts are on-chain units ÷ 1,000,000. Addresses are shown shortened, exactly as
returned — no names or identities are guessed or attached to any address.

## Refresh

- Snapshot cache: 300s (`Cache API`).
- Cron trigger: hourly at minute 5, rebuilds both chains.
- A stale last-good snapshot is kept for up to 24h and served if the upstream
  API is briefly down.
- The page shows a visible “Data as of … UTC” timestamp.

## Deploy (one command)

```sh
CLOUDFLARE_API_TOKEN=<token with Workers Scripts:Edit> \
CLOUDFLARE_ACCOUNT_ID=<account id> npm run deploy
```

That builds `dist/worker.js` (embeds `og-1200x630.jpg` as base64), uploads the
Worker as `taskmarket-visualizer`, sets the hourly cron trigger, enables the
`*.workers.dev` subdomain, and prints the live URL. Requires Node 18+ and
nothing else — no wrangler, no npm install.

To deploy under a different name: `WORKER_NAME=my-name npm run deploy`.

Check it:

```sh
npm test   # node --check worker.js
curl -s -o /dev/null -w '%{http_code} %{time_total}s\n' https://taskmarket-visualizer.<your-subdomain>.workers.dev
```

## Local test

```sh
node --check worker.js
# Render against the live API with a stubbed Cache API (see test/ in the repo
# history) — or simply deploy and curl the public URL.
```

## Brand

Follows the Taskmarket brand kit (ground `#12100E`, maroon `#3A1420`, panel
`#221E1A`, cream `#EFE9E2`, magenta `#E74079` used only as an accent, Instrument
Serif headlines, Inter Tight body, Departure Mono for the address and numbers).
The lockup in the header is Taskmarket's own, loaded unmodified from the brand
kit. Copy sticks to the kit's fact sheet — no banned words, no invented numbers.

## Licence

MIT — see [LICENSE](LICENSE).
