# AI Usage Dashboard — Interview Prep (End to End)

Side project: a personal, account-aware ledger of AI coding spend across five
providers — Codex, Claude, Grok, OpenCode, Antigravity — with tokens + USD cost
per provider and per model, a 30/60/90-day dashboard, twice-daily Telegram
digests, and one-command sync without cloning the repo.

## 1. The 60-second story

"I wanted one number for what my AI coding actually costs. Existing tools were
single-provider, single-machine, or showed quota percentages instead of token
history. So I built a pipeline: local parsers read each tool's session files
and upload **totals only** to a hosted API; a Next.js dashboard aggregates
across devices and date ranges; a cron digest messages me twice a day; and the
collector ships as an npm package plus an OpenCode slash command, so any
machine syncs with one command and no repo checkout."

## 2. Problem analysis (why build, not reuse)

- `ccusage`-style tools cover one provider on one machine. I use five.
- Subscription billing (ChatGPT Plus/Pro, Claude Pro/Max, SuperGrok) has **no
  historical token API** — only quota percentages and reset timers. Any dollar
  figure for these is necessarily an API-price *estimate*, never the bill.
- T3 Code (open source, which I studied as a reference) scans transcript files
  on every connected machine — same constraint I arrived at independently. Its
  account endpoint reports quota windows only, not history.
- Only two account-level history sources exist: OpenCode's usage-export CSV
  (per-request tokens + actual charged cost) and OpenAI's Enterprise analytics
  (workspace Admin key only — not personal plans).

## 3. Architecture

```
PC session files ── collector (Bun/Node, zero deps) ── POST /v1/ingest ─┐
                                                                       ├─► Turso (libSQL) ─► Next.js dashboard + Telegram digest cron
OpenCode cloud export ── /api/cron/sync (server-side, no PC job) ──────┘
```

- `collector/`: per-provider parsers → priced day payloads → idempotent upserts.
- `web/`: Next.js app + API routes + Vercel cron, Turso persistence.
- `server/`: self-host alternative (Hono + SQLite) with identical API semantics.
- Privacy rule enforced end to end: only
  `{day, provider, model, token counts, costUsd, sessions, records}` leave the
  PC. No prompts, completions, file contents, paths, or credentials — verified
  by a contract test that scans the DB blob for path patterns.

## 4. Approaches that mattered (per area)

### 4.1 Provider parsing — every format lies a little differently

- **Codex** (`~/.codex/sessions/*.jsonl`): `token_count` events carry
  `last_token_usage` *deltas*; summing them reconciles with the session's final
  `total_token_usage`. Three dedup layers: consecutive-identical signatures,
  fork/subagent suppression (copied parent history re-stamped within <1s is
  dropped; first genuine child turn ends suppression), and global
  provider+dedupeKey dedup at aggregation.
- **Grok** (`updates.jsonl` `turn_completed`): per-turn usage with cost in
  1e10 ticks = $1. I cross-validated against T3 Code's parser on my own 340
  files — exact parity: 14 records, $3.6771564 both sides. Adopted their cost
  allocation (aggregate turn cost pro-rated across models missing ticks),
  prompt-ID dedup, and no-modelUsage fallback record.
- **OpenCode** (`opencode.db` SQLite → JSON fallback): assistant messages carry
  `{input, output, reasoning, cache:{read, write}}` plus `cost` (0 for Zen —
  billing happens server-side, so local rows are table-priced).
- **Antigravity**: stores no token counts, only `gen_metadata`, so turns are
  estimated from configured averages and flagged `est.` in the UI.
- **Key bug found by real data**: Zen free-tier models (`*-free`) substring-
  matched paid LiteLLM rates — `deepseek-v4-flash-free` (443M tokens!) priced
  at $17.12. Fixed with a `-free` → $0 short-circuit; tokens still counted.

### 4.2 Pricing

LiteLLM + models.dev tables, cached 24h, last-good reused offline. Priority:
`reportedCost → table → unpriced (tokens kept, cost 0)`. Exact
provider-neutral model IDs win over regional variants (a generic
`azureusgpt-5.6-sol` entry was overriding `gpt-5.6-sol` and inflating Codex by
~37%). Tiered rates (e.g. above-272k) deliberately priced at base tier, same
call T3 Code makes — transcripts don't record which tier served a request.

### 4.3 Incremental correctness

Per-file byte-offset cache + per-file record cache so repeat runs push
**full-day** totals (server upserts replace whole days). Schema-versioned cache
keys force clean re-baselines after parser semantics change. A real bug:
30-day caches silently dropped older in-file events when widening to 90 days —
fixed with window-aware invalidation (`cacheSinceDay`), verified by clean-scan
comparison (August Codex 448,638,364 tokens both ways).

### 4.4 Multi-device + cloud merge

Upsert by `(deviceId, day)`; summary sums across devices. Cloud OpenCode rows
(`deviceId cloud:opencode`) are authoritative per day so local rows aren't
double-counted. Coverage metadata in the API tells the UI `Account-wide` vs
`This device`, with an honest note where no account API exists. Codex-
subscription turns run inside OpenCode are verified disjoint from CLI rollouts
(0 overlapping turns across ~30k records) and labeled `openai/<model>` —
single-counted under OpenCode, cost-neutral pricing.

### 4.5 Dashboard

Day + range KPIs, 30/60/90D selector, provider filter chips, tokens/cost
toggle, zero-filled SVG chart, range-based provider cards (fixed a bug where
cards showed one day against a 90-day chart), day-scoped model table,
B/M/T compact formatting, explicit empty states instead of blank charts.

### 4.6 No-clone distribution

Collector is pure Node builtins (`node:sqlite` with `bun:sqlite` fallback), so
it published as `ai-usage-collector` with zero dependencies — `bunx
ai-usage-collector@latest --push` from any folder. A global OpenCode command
(`/sync-usage`, `~/.config/opencode/commands/sync-usage.md`) runs the same
push from inside any session, refusing to run when env vars are missing.

### 4.7 Free-tier deployment

Vercel Hobby (Next.js + cron, daily-cadence limit respected) + Turso free tier.
Two gotchas solved: Vercel **Root Directory must be `web/`** (repo root has no
build), and an **Ignored Build Step** (`git diff HEAD^ HEAD --quiet -- web/`)
so collector-only pushes don't fail/trigger deploys.

## 5. Verification habit

- `--dry-run` before every push; focused repro scripts per bug.
- Differential testing: my parsers vs T3 Code on identical files (Grok: exact
  dollar parity; Codex: ~$313 vs T3's ~$300).
- `server/verify.mjs`: 16 contract checks (auth, upsert-replace, stale
  fallback, no-PII scan, range clamping) — run after every backend change.
- Production builds (`next build`, `tsc`, Bun bundle) as gates; `git diff
  --check` before commits; split commits by concern.

## 6. Honest limitations (say these unprompted)

- Subscription dollar figures are API-equivalent estimates, not bills.
- OpenCode cloud export covers ~30 days; older history needs the collector.
- Personal Codex/Claude/Grok history fundamentally requires local file reads —
  no account API exists; only Enterprise analytics escapes this.
- Antigravity numbers are estimates; free-tier models show tokens at $0 and
  sort to the bottom of the cost-ordered model table.
- Model table aggregates across the selected range (daily points carry their
  own model breakdowns, merged range-wide like the cards).

## 7. Likely interviewer questions

**Q: How do you get usage data without official APIs?**
A: Read the tools' own session transcripts on disk — the same files their
TUI/CLI writes. Codex deltas, Grok per-turn ledgers, OpenCode SQLite, Claude
transcripts; estimate only where nothing is stored (Antigravity).

**Q: How do you avoid double counting?**
A: Four layers: intra-file (identical consecutive events, fork-copy bursts,
retried prompt IDs), cross-run (provider+dedupeKey global set), cross-device
((device, day) upserts summed, not overwritten), cloud-vs-local (cloud
OpenCode authoritative per exported day).

**Q: Why did Codex disagree with T3 Code, and how did you close the gap?**
A: Two defects: Azure regional rates shadowing exact model rates in my
substring matcher, and forked rollouts replaying parent history. Fixed exact-
first lookup + 1s-gap fork suppression; landed within ~4% ($313 vs ~$300 on
the same history).

**Q: How did you validate the Grok parser?**
A: Ran both parsers over the same 340 session files and compared record
counts and summed cost: 14 records and $3.6771564 on both sides, then ported
their allocation/dedup semantics verbatim.

**Q: What was the trickiest bug?**
A: The 30→90-day cache bug: incremental per-file caches built under a narrow
window permanently hid older in-file events. It looked like "June/July are
empty" in the UI but was a collector caching defect — caught by diffing a
clean scan against the cached scan, fixed with window-aware invalidation.

**Q: How is privacy enforced, not just promised?**
A: parsers extract numeric totals into a fixed schema; payload type has no
string fields except day/provider/model; a contract test greps the stored DB
blob for absolute-path patterns; collector never opens credential files.

**Q: Why Turso + Vercel Hobby instead of Postgres/a VPS?**
A: Workload is tiny append-mostly daily rows; libSQL keeps SQLite semantics
with zero ops; Hobby cron's once-daily limit fits a 2×/day digest; total cost
$0. The `server/` Hono+SQLite target preserves an exit path off Vercel.

**Q: How does one-command sync work with no repo?**
A: The collector has zero dependencies and runs on Bun or Node 22+, so it's
an npm package with a bin entry; `bunx` fetches and runs it. State lives in
`~/.usage-dash`, env vars carry credentials. The OpenCode `/sync-usage`
command is just a checked-in prompt that invokes the same package.

**Q: What would you build next?**
A: Token-sorted model view so $0 free-tier giants like the 443M DeepSeek rows
surface above paid rows;
Codex Enterprise analytics integration for true account-wide Codex; alerting
on week-over-week spend deltas.

## 8. Receipts (90-day run, this machine)

- Codex: ~1.09B tokens → **$312.98** API-equivalent.
- Grok: 14 turns → **$3.68** (exact T3 parity).
- OpenCode local: 1.7B Muse-Spark-contributor-free tokens at $0; 521M
  gpt-5.6-sol → $272.11; 443M deepseek-v4-flash-free → $0 (after fix).
- Server contracts 16/16; `next build`, `tsc`, Bun bundle green.
