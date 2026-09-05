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
server/     Hono + SQLite — index.ts, routes.ts, db.ts, digest.ts,
            Dockerfile, fly.toml, render.yaml, .env.example, verify.mjs
web/        Next.js + TypeScript PWA — app/{layout,page,globals.css},
            lib/{api,format}, public/{manifest.webmanifest,sw.js,icons/}
```

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
  record cache so repeat runs still push **full**-day totals).
- Exit code is always 0 (cron-friendly); one missing provider never fails the run.
- Pricing: LiteLLM + models.dev tables, cached to disk 24h, last-good reused on
  failure. Cost priority: `reportedCost` → table price → unpriced (tokens kept,
  cost 0). Antigravity has no stored token counts: turns from `gen_metadata`
  rows × `ANTI_AVG_INPUT/OUTPUT/CACHED` env averages, priced via table, flagged
  estimated (`est.` in UI).
- Token math: `total = uncached + cached + cacheCreation + output`; reasoning is
  a subset of output, never added.
- Never reads `~/.claude/.credentials.json` / `~/.codex/auth.json`; provider API
  keys are not used anywhere.

Schedule:

- **Windows** (Task Scheduler, every 15 min + on boot):
  `schtasks /create /tn "UsageDash" /tr "bun 'C:\path\to\collector\index.ts --push'" /sc minute /mo 15 /f`
  (see `collector/schedule-windows.ps1`).
- **Linux**: `collector/usage-dash.{service,timer}` (systemd, 15 min + boot).

## 2. Server (always on — Fly.io or Render)

```powershell
cd server
npm install
cp .env.example .env   # DATABASE_URL, INGEST_TOKEN, READ_TOKEN, SITE_ORIGIN, Telegram...
npm start              # :8787  (npm run dev for watch)
node digest.ts --once  # manual digest send (cron alternative)
npx tsx verify.mjs     # 13 endpoint/contract checks against throwaway :memory: DB
```

Generate tokens: `openssl rand -hex 32` (separate values for ingest/read).

| Endpoint | Auth | Behaviour |
|---|---|---|
| `POST /v1/ingest` | `Bearer $INGEST_TOKEN` | Upsert by `(deviceId, day)` → `{ok:true}` |
| `GET /v1/summary?day=YYYY-MM-DD` | `Bearer $READ_TOKEN` | Latest day ≤ requested; `isStale` when `now-lastPushAt>30min` or day mismatch; includes 30-day `daily` + `models` |
| `GET /v1/last-day` | either token | `{lastDay}` (collector backfill anchor) |
| `GET /health` | none | `{ok:true}` |

CORS allows only `$SITE_ORIGIN`. No provider keys on the server.

Deploy:

- **Fly.io**: `cd server && fly launch` (uses `fly.toml`; `/data/usage.db` volume).
- **Render**: new Web Service from `server/render.yaml` (persistent disk at `/data`).

Telegram digest runs in-process at **09:00 + 21:00** (`$CRON_TZ`) plus an
`ALERT over $N` prefix when the day exceeds `$ALERT_THRESHOLD_USD` (default 20):

```
Usage 2026-09-04 $12.40 (Codex $5.00 80k, Claude $4.00 60k, Grok $1.00, OpenCode $2.00, Antigravity ~$0.40 est.) Updated 10m ago
```

Email fallback via Resend (`RESEND_API_KEY` + `DIGEST_EMAIL_TO`) if Telegram is
unreachable. Without either configured the loop stays off.

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

- Collector `.env`: `API_URL, INGEST_TOKEN, DEVICE_ID, DEVICE_LABEL`
  (no `TELEGRAM_*` here).
- Server `.env`: `DATABASE_URL, INGEST_TOKEN, READ_TOKEN, TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID, RESEND_API_KEY (optional), CRON_TZ` — see
  `server/.env.example`.
- Web `.env.local`: `NEXT_PUBLIC_API_URL, NEXT_PUBLIC_READ_TOKEN`
  (`VITE_API_URL` / `VITE_READ_TOKEN` also honoured as fallback).
- Provider API keys: **none required**. Never upload auth/credential files.

## Acceptance (verified 2026-09-05)

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
