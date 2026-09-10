# AI Usage Dashboard

Personal dashboard for AI coding usage: tokens + USD cost per provider
(`codex`, `claude`, `grok`, `opencode`, `antigravity`).

One data source, two surfaces:

- **Website** (Next.js + TypeScript PWA, Vercel) — bookmark it; works when the PC
  is off (shows last push + stale badge) and offline (last cached data).
- **Android with no custom app** — PWA Add-to-Home-Screen + Chrome bookmark
  shortcut widget + Telegram/Gmail digest. No APK, no Play release.

```
PC files -> collector --dry-run -> POST /v1/ingest -> SQLite -> GET /v1/summary -> web PWA + Telegram digest
```

**Privacy rule:** prompts, completions, file contents, and absolute paths NEVER
leave the PC. Only `{day, provider, model, token counts, costUsd, sessions,
records}` are uploaded. `--dry-run` prints the payload without uploading.

Light database: plain **SQLite** (`node:sqlite`, no native addons, no Postgres).

## Repo layout

```
collector/  Bun+TS — index.ts, parsers/{claude,codex,grok,opencode,antigravity}.ts,
            pricing.ts, state.ts, types.ts, sqlite.ts, .env.example
server/     Self-host alternative (Hono + SQLite) — index.ts, routes.ts, db.ts,
            digest.ts, Dockerfile, fly.toml, render.yaml, .env.example, verify.mjs
web/        Vercel app (Next.js + TS PWA + API routes) — app/{layout,page,globals.css},
            app/api/{v1/{ingest,summary,last-day},health,cron/digest},
            lib/{api,format,store,digest}, public/{manifest.webmanifest,sw.js,icons/}
```

Deploy target: **everything on Vercel** (one project from `web/`).
Web page + API routes + cron digest run together; persistence is Turso
(libSQL — still light SQLite semantics, no Postgres). `server/` remains as a
Fly.io/Render self-host alternative with identical API semantics.

## 1. Collector (PC, every 15 min)

Requires [Bun](https://bun.sh). No `npm install` needed (built-ins only).

```powershell
cd collector
cp .env.example .env   # fill API_URL, INGEST_TOKEN, DEVICE_ID, DEVICE_LABEL
bun run index.ts -- --days 30 --dry-run   # prints payload, no upload
bun run index.ts -- --push                # backfills from /v1/last-day, uploads
bun run index.ts -- --push --data-dir D:\usage-state   # state dir override
```

- Scans files with mtime >= window start − 36h slack; incremental via
  `~/.usage-dash/state.json` (skip unchanged, resume grown files, per-file
  record cache so repeat runs still push **full**-day totals). Widening the
  requested range invalidates narrower caches before the backfill.
- Exit code is always 0 (cron-friendly); one missing provider never fails the run.
- Pricing: LiteLLM + models.dev tables, cached to disk 24h, last-good reused on
  failure. Exact provider-neutral model IDs take priority, matching T3 Code's
  base-tier LiteLLM lookup. Cost priority: `reportedCost` → table price →
  unpriced (tokens kept, cost 0). Antigravity has no stored token counts: turns from `gen_metadata`
  rows × `ANTI_AVG_INPUT/OUTPUT/CACHED` env averages, priced via table, flagged
  estimated (`est.` in UI).
- Token math: `total = uncached + cached + cacheCreation + output`; reasoning is
  a subset of output, never added.
- **Grok**: `turn_completed` events carry that turn's own usage (per-prompt
  ledger, verified against the open-source CLI); cost ticks are 1e10 = $1.
  T3 Code-compatible semantics retain reported zero costs, deduplicate retried
  prompt IDs, and allocate aggregate turn cost across models missing their own
  ticks. Turns without a per-model split become one `grok` totals record.
- Never reads `~/.claude/.credentials.json` / `~/.codex/auth.json`; provider API
  keys are not used anywhere.

Schedule:

- **Windows** (Task Scheduler, every 15 min + on boot):
  `schtasks /create /tn "UsageDash" /tr "bun 'C:\path\to\collector\index.ts --push'" /sc minute /mo 15 /f`
  (see `collector/schedule-windows.ps1`).
- **Linux**: `collector/usage-dash.{service,timer}` (systemd, 15 min + boot).

### Sync without cloning the repo

The collector is published as `ai-usage-collector` (Bun or Node 22+, zero
dependencies). Set four env vars once per machine, then sync with one command:

~~~powershell
$env:API_URL="https://<app>.vercel.app"
$env:INGEST_TOKEN="<prod-ingest-token>"
$env:DEVICE_ID="my-pc"; $env:DEVICE_LABEL="Desktop PC"
bunx ai-usage-collector@latest --push --days 30
~~~

State lives in `~/.usage-dash/state.json`, so repeat runs stay incremental with
no checkout. In OpenCode, `/sync-usage` runs the same push (`/sync-usage 90`
backfills 90 days); the command is installed globally at
`~/.config/opencode/commands/sync-usage.md`.

## 2. API + DB (Vercel + Turso — primary path)

The API lives in the web app (`web/app/api/...`), so one Vercel project hosts
page + API + digest cron. `server/` is the self-host alternative (Fly/Render).

```powershell
cd web
npm install
cp .env.example .env.local   # see credentials below
npm run dev                  # local: API uses file:./data/usage.db
```

| Endpoint | Auth | Behaviour |
|---|---|---|
| `POST /v1/ingest` | `Bearer $INGEST_TOKEN` | Upsert by `(deviceId, day)` → `{ok:true}` (rewritten to `/api/v1/ingest`) |
| `GET /v1/summary?day=YYYY-MM-DD` | `Bearer $READ_TOKEN` | Latest day ≤ requested; `isStale` when `now-lastPushAt>30min` or day mismatch; includes range `daily` (per-provider) + `models` |
| `GET /v1/last-day` | either token | `{lastDay}` (collector backfill anchor) |
| `GET /health` | none | `{ok:true}` |
| `GET /api/cron/digest` | `Bearer $CRON_SECRET` | Telegram/email digest for the last day (Vercel Cron 09:00 + 21:00 IST) |
| `GET /api/cron/sync` | `Bearer $CRON_SECRET` | Pull provider billing APIs into the DB (no PC job); digest also runs this first |

Deploy:

1. Push this repo to GitHub.
2. Vercel → Add New → Project → import repo, set **Root Directory to `web/`**.
3. Create a free Turso database (`turso db create usage-dash`, `turso db show
   --url`, `turso db tokens create`) — or via https://turso.tech dashboard.
4. Add env vars in Vercel (Production + Preview): `TURSO_DATABASE_URL`,
   `TURSO_AUTH_TOKEN`, `INGEST_TOKEN`, `READ_TOKEN`, `CRON_SECRET`,
   `NEXT_PUBLIC_API_URL` (= your `https://<app>.vercel.app`),
   `NEXT_PUBLIC_READ_TOKEN` (= same as `READ_TOKEN`), plus Telegram/Resend vars.
5. Deploy. Cron jobs (`vercel.json`: 03:30 + 15:30 UTC = 09:00 + 21:00 IST) call
   `/api/cron/digest` automatically with `CRON_SECRET`.

Telegram digest text (overspend prefixed with `ALERT over $20:`):

```
Usage 2026-09-04 $12.40 (Codex $5.00 80k, Claude $4.00 60k, Grok $1.00, OpenCode $2.00, Antigravity ~$0.40 est.) Updated 10m ago
```

Email fallback via Resend (`RESEND_API_KEY` + `DIGEST_EMAIL_TO`) if Telegram is
unreachable. Without either configured the cron returns `no-channel`.

### Self-host alternative (Fly.io / Render)

```powershell
cd server
npm install
cp .env.example .env   # DATABASE_URL, INGEST_TOKEN, READ_TOKEN, SITE_ORIGIN, Telegram...
npm start              # :8787  (npm run dev for watch)
node digest.ts --once  # manual digest send (cron alternative)
npx tsx verify.mjs     # 13 endpoint/contract checks against throwaway :memory: DB
```

Generate tokens: `openssl rand -hex 32` (separate values for ingest/read).

CORS allows only `$SITE_ORIGIN`. No provider keys on the server.

- **Fly.io**: `cd server && fly launch` (uses `fly.toml`; `/data/usage.db` volume).
- **Render**: new Web Service from `server/render.yaml` (persistent disk at `/data`).

## 3. Website (Vercel)

```powershell
cd web
npm install
cp .env.example .env.local   # NEXT_PUBLIC_API_URL, NEXT_PUBLIC_READ_TOKEN
npm run dev                  # or npm run build && npm start
```

Deploy: import `web/` in Vercel, set the two env vars. `vercel.json` included.

- Single page `/?day=YYYY-MM-DD`: header totals, stale banner
  ("Updated Xh ago — PC offline, showing last data"), provider rows with share,
  pure-CSS 30-day bars, model table, pricing/last-push footer.
- Cache-first render: `localStorage` last summary renders instantly, then
  revalidates; skeletons while cold-loading.
- PWA: manifest `Usage`, standalone, service worker caches app shell +
  cache-first `GET /v1/summary`, so an offline open shows last data.

## Account sync (no PC job, cross-device)

The collector reads local files per device (run it on each device with a
different `DEVICE_ID` — the server merges them). For providers with a billing
API, the server can instead pull **account-level** usage itself on a schedule —
no PC job, all devices covered automatically:

| Provider | Account API? | Auth | Covers |
|---|---|---|---|
| OpenCode (Zen/Go) | ✅ Usage export CSV | service key `oc_sk_...` | per-request tokens + actual charged cost |
| OpenAI | Enterprise only | Workspace Admin key | Codex Enterprise Analytics; **not** personal Plus/Pro history |
| Anthropic | ✅ org Admin API (orgs only) | Admin key | API org usage — **not** Pro/Max subscription, not individuals |
| xAI/Grok | ❌ console dashboard only | — | SuperGrok/subscription not exposed |
| Google/Antigravity | complex (Cloud Billing, GCP only) | OAuth | not the free tier |

T3 Code does not fetch historical Codex token totals from the ChatGPT account.
It scans Codex, Claude, and Grok transcript files on every connected environment;
its account endpoint reports quota-window percentages only. Therefore personal
Codex Plus/Pro history cannot be made account-wide without reading each device.

Setup (OpenCode): create a service-account key in the opencode console, set
`OPENCODE_SERVICE_KEY` (+ optional `OPENCODE_CONSOLE_URL`) in Vercel env, and
redeploy. The digest cron then syncs the last 30 days (idempotent upserts under
device `cloud:opencode`; days are UTC). Manual trigger:
`GET /api/cron/sync` with `Bearer $CRON_SECRET`.

Cloud OpenCode rows are authoritative for each exported day, so matching local
rows are not double-counted. You can still set `SKIP_PROVIDERS=opencode` in the
collector `.env` to avoid unnecessary local parsing.

## 4. Android (no custom app)

1. **PWA**: Chrome → open the site → ⋮ → **Add to Home screen**. Done — one tap,
   standalone window, no search.
2. **Bookmark widget**: long-press homescreen → **Widgets** → **Chrome** →
   **Bookmark shortcut** → select the site. One-tap open fallback.
3. **Digest**: Telegram bot message 2× daily (+ overspend alert); Gmail via
   Resend if Telegram is absent. The phone never polls in background — it only
   fetches on open.

Telegram setup: message `@BotFather` → `/newbot` → token → `$TELEGRAM_BOT_TOKEN`;
message `@userinfobot` for your chat id → `$TELEGRAM_CHAT_ID`; set both as
server env vars and redeploy.

## Credentials (exact env)

- Collector `.env`: `API_URL` (= `https://<app>.vercel.app`, no path suffix —
  `/v1/*` is rewritten to the API routes), `INGEST_TOKEN, DEVICE_ID,
  DEVICE_LABEL, SKIP_PROVIDERS (optional, e.g. `opencode` when cloud-synced)`
  (no `TELEGRAM_*` here).
- Vercel env vars: `TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, INGEST_TOKEN,
  READ_TOKEN, CRON_SECRET, NEXT_PUBLIC_API_URL, NEXT_PUBLIC_READ_TOKEN`
  (+ `TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, RESEND_API_KEY (optional),
  DIGEST_EMAIL_TO (optional), ALERT_THRESHOLD_USD (default 20),
  OPENCODE_SERVICE_KEY + OPENCODE_CONSOLE_URL (optional, account sync)`) — see
  `web/.env.example`.
- Self-host `server/.env` (only if using Fly/Render instead): `DATABASE_URL,
  INGEST_TOKEN, READ_TOKEN, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
  RESEND_API_KEY (optional), CRON_TZ`.
- Provider API keys: **none required**. Never upload auth/credential files.

## Acceptance (verified 2026-09-05, Vercel-style stack E2E 2026-09-06)

- [x] `collector --dry-run` prints all 5 providers, no network push.
- [x] Repeat runs are idempotent (incremental cache returns identical totals).
- [x] Live push → `summary` exact day fresh; future day → last day + `isStale`.
- [x] `verify.mjs`: 13/13 (auth, upsert-replace, fallback, no absolute paths in DB).
- [x] DB/file secret scan: no prompts, tokens, or credential paths stored.
- [x] Antigravity rows flagged estimated end-to-end (parser → API → UI badge).
- [x] `next build` clean; `/`, `/manifest.webmanifest`, `/sw.js` all serve 200.
- [ ] Telegram message received twice daily — needs real bot token (code path
  exercised with `--once`, delivery pending credentials).
- [ ] Lighthouse "installable" — checklist met (name/display/icons/SW); run
  Lighthouse in Chrome after Vercel deploy to confirm.
