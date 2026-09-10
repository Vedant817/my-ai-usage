# AI Usage Dashboard — Interview Prep

Side project: a personal, account-aware ledger of AI coding spend across five
providers (Codex, Claude, Grok, OpenCode, Antigravity) — tokens + USD per
provider and per model, 30/60/90-day dashboard, twice-daily Telegram digests,
one-command sync with no repo clone.

How to use this file: each section follows **Done → Challenge → Discovery →
Solution → Counter-questions**, so any follow-up the interviewer asks is
already answered below it.

---

## 0. The 60-second pitch

"I wanted one number for what my AI coding actually costs. Existing tools were
single-provider, single-machine, or showed quota percentages instead of token
history — and subscription plans expose no historical token API at all. So I
built a pipeline: local parsers read each tool's session files and upload
**totals only** to a hosted API; a Next.js dashboard aggregates across devices
and ranges; a cron digest messages me twice daily; and the collector ships as
an npm package plus an OpenCode slash command, so any machine syncs with one
command and no checkout."

---

## 1. Privacy-first ingestion pipeline

**Done:** PC session files → per-provider parsers → priced day payloads →
`POST /v1/ingest` → Turso → dashboard. Only
`{day, provider, model, token counts, costUsd, sessions, records}` ever leave
the machine.

**Challenge:** Usage files sit next to prompts, completions, file contents,
and credential files. A careless `JSON.stringify(row)` would exfiltrate all of
it, and I needed this to be *structurally* safe, not just carefully coded.

**Discovery:** I mapped exactly which fields each parser touches and realized
the safety property should live in the types: if the payload type has no free-
text fields, no parser can leak them by accident.

**Solution:** `UsageRecord`/`DayPayload` carry numerics plus three short
strings (day, provider, model). `upsertDay` sanitizes to a fixed key list and
drops everything else. A contract test (`verify.mjs`) greps the stored DB blob
for absolute-path patterns (`C:\`, `/home/`, `X:/`) on every run. The collector
never opens `~/.claude/.credentials.json` or `~/.codex/auth.json`.

**Counter-questions:**
- *Q: How is privacy enforced, not just promised?* — A: Fixed schema with no
  free-text fields, server-side sanitization to a key allowlist, and an
  automated no-PII scan of stored rows; credential files are never opened.
- *Q: What if a parser hits a corrupt or hostile file?* — A: Every file/row
  parse is wrapped; one bad row increments `skipped`, one bad provider can't
  fail the run, exit code stays 0 for cron.
- *Q: Why not encrypt the payload?* — A: Nothing sensitive is in it by
  construction; encryption would add key management for zero additional
  privacy. Secrets (ingest token) travel via Bearer auth + HTTPS.

---

## 2. Codex parser + the 37% pricing inflation

**Done:** Parser for `~/.codex/sessions/*.jsonl` producing per-turn records;
landed within ~4% of T3 Code's estimate ($312.98 vs ~$300 on the same history).

**Challenge (a):** `token_count` events carry `last_token_usage` *deltas*, and
forked/subagent rollouts copy the parent's full history re-stamped to the fork
instant — naive summing double/triple counts. **Challenge (b):** my Codex total
came out ~37% higher than T3 Code's on identical files.

**Discovery:** (a) I diffed parent vs child rollouts and saw the copied burst
lands with 0–40ms gaps while a genuine child turn takes 5s+ — a 1s threshold
splits them cleanly (same call `ccusage` makes). Summed deltas reconciled with
each session's final `total_token_usage`, confirming the math. (b) I dumped
which rate each model resolved to and found `gpt-5.6-sol` matching
`azureusgpt-5.6-sol` ($5.50/$33) instead of the exact entry ($4/$20) — my
longest-substring matcher allowed the *table key* to contain the model name
instead of only the reverse.

**Solution:** Three dedup layers (consecutive-identical signatures, <1s
fork-burst suppression keyed on `forked_from_id`/subagent spawn metadata,
global provider+dedupeKey dedup at aggregation) plus exact-first rate lookup
with one-directional substring fallback.

**Counter-questions:**
- *Q: How do you know the deltas are right?* — A: Summed per-session deltas
  reconcile with each rollout's own final `total_token_usage`.
- *Q: Why not just trust the final total per session?* — A: I need per-day and
  per-model attribution; the final total has neither. Deltas give both.
- *Q: Could the 1s fork threshold drop real turns?* — A: Only if a genuine
  model round-trip completes in under 1s right after a fork — never observed
  (5s+), and the suppression ends permanently at the first slow event.

---

## 3. Grok parser, validated to the dollar against T3 Code

**Done:** Parser for Grok `updates.jsonl` `turn_completed` events (per-turn
usage, cost in 1e10 ticks = $1).

**Challenge:** Grok's schema is subtle — inclusive input tokens, per-model
splits under `usage.modelUsage`, aggregate-level cost ticks, retried prompts
reusing IDs — and I had no ground truth for whether my reading was right.

**Discovery:** T3 Code is open source with a well-tested Grok parser
(`usageTranscripts.ts` + tests). Instead of trusting my interpretation, I ran
**both parsers over my own 340 session files** and compared record counts and
summed cost.

**Solution:** First run disagreed ($4.92 vs $3.68) — the diff exposed three
real defects in mine: repricing reported-$0 turns via table, missing
aggregate-cost allocation to unticked models, and timestamp-suffixed dedup keys
that split retries T3 merges. I ported their semantics verbatim (prompt-ID
dedup, remainder pro-rating, no-split fallback record) and re-ran: **14
records and $3.6771564 on both sides.** Differential testing against a
reference implementation is now my default for wire formats.

**Counter-questions:**
- *Q: Why trust T3 Code as ground truth?* — A: I didn't blindly — their parser
  has unit tests with hand-computed tick values, and their semantics matched
  the open-source grok-build CLI comments. Agreement of three sources
  (CLI docs, their tests, my files) is what closed it.
- *Q: What did you keep different from theirs?* — A: Timestamp handling on
  missing prompt IDs and my global cross-run dedup layer, which theirs pushes
  downstream. Same records, different layering.
- *Q: What breaks if xAI changes the schema?* — A: Unknown fields are ignored
  by shape-checked readers; a missing `modelUsage` degrades to one totals
  record; zero-token turns are skipped. Worst case is undercounting, never a
  crash or a wrong number presented as right.

---

## 4. The DeepSeek $17.12 bug (free-tier pricing)

**Done:** `deepseek-v4-flash-free` — 443M tokens, my heaviest OpenCode model —
showed $17.12 instead of $0.

**Challenge:** It looked like a data problem ("where is my DeepSeek usage?")
but was actually a pricing problem, and it was *inconsistent*: other `-free`
models correctly showed $0.

**Discovery:** I dumped the resolved rate per model and saw
`deepseek-v4-flash-free` substring-matching paid `deepseek-v4-flash`
($0.44/$1.32). The models showing $0 simply had no table entry at all — the
bug only bit where a paid namesake existed. Same defect had put $0.30 on
`nemotron-3-ultra-free`.

**Solution:** A `-free` suffix short-circuit in `price()` returning $0 with
tokens kept (matching OpenCode Zen's published free-tier list), plus a
regression check in the dry-run output. Verified: 443.6M tokens → $0.00, paid
`deepseek-v4-flash` (2 messages) still table-priced.

**Counter-questions:**
- *Q: Why not fix the matcher instead?* — A: The matcher is correct for paid
  models — `deepseek-v4-flash-free` genuinely *contains* the paid name. The
  knowledge "this suffix means free" belongs one layer up, as a pricing rule.
- *Q: What if a paid model ends in -free?* — A: Accepted risk, documented;
  Zen's convention is consistent today, and the rule is one line to revisit.
- *Q: How would you catch this class automatically?* — A: A per-model
  cost-per-token sanity bound in dry-run output (flag rows whose implied rate
  deviates from the table rate) — on my roadmap.

---

## 5. The vanishing June/July history (incremental-cache bug)

**Done:** 90-day backfill now covers Jun 14 → Sep 10 (40 active days),
verified identical between clean and cached scans (August Codex 448,638,364
tokens both ways).

**Challenge:** The chart showed June/July as zero despite session files
existing there. It looked like a UI or database problem.

**Discovery:** I ran a clean 90-day scan (fresh state dir) against the normal
incremental scan and diffed monthly totals — the cached scan was missing
~114M August Codex tokens. Root cause: per-file caches built during an earlier
**30-day** run had discarded older in-file events; widening to 90 days reused
those files as "unchanged," so the old events stayed invisible forever.

**Solution:** Window-aware cache invalidation (`cacheSinceDay` — widening the
range re-reads), plus schema-versioned cache keys so parser-semantics changes
force one clean re-baseline instead of mixing old and new records.

**Counter-questions:**
- *Q: Why cache per-file records at all?* — A: Multi-hundred-MB rollouts get
  re-pushed every 15 minutes; the cache makes repeat runs O(append) while the
  server upsert still replaces whole days, so totals stay exact.
- *Q: Why not just always rescan?* — A: Correctness would be trivially fine,
  but a 15-minute cron re-reading gigabytes is rude on a laptop. The cache is
  a performance optimization with a proven-correct invalidation rule.
- *Q: How do you know the fix is complete?* — A: Clean-scan vs cached-scan
  comparison across all four months, all providers — exact match, then pushed.

---

## 6. Dashboard range consistency (three UI bugs, one principle)

**Done:** 30/60/90D selector, day+range KPIs, provider chips, tokens/cost
toggle, zero-filled chart, B/M/T formatting, explicit empty states.

**Challenge:** Three inconsistencies, all the same root cause — different
sections answered different questions: (a) provider cards showed **one day**
against a 90-day chart ($13.34 vs ~$313); (b) the Models table stayed
day-pinned while the 90D filter was on, hiding DeepSeek entirely; (c) cards
summed the whole payload instead of the selected window.

**Discovery:** A screenshot review against the API payload: the data was
correct in the DB, the API returned the right series — only the view layer
mixed granularities. The principle I adopted: **every section except the
explicit "Day" KPIs answers the selected range.**

**Solution:** Daily points carry their own model breakdowns (both stores);
cards, models, shares, and footer all aggregate the same range window.
Verified the 90D model table against prod data: DeepSeek 443.6M @ $0.00
listed.

**Counter-questions:**
- *Q: Why did the day-scoped table survive so long?* — A: It was correct when
  the dashboard was day-only; the range selector was added later without
  revisiting every consumer. Lesson: when you add a global control, audit all
  readers of the data it should affect.
- *Q: Payload cost of per-day models?* — A: ~90 days × ~10 small rows —
  negligible next to the token buckets, and cloud-authority filtering is
  applied before shipping so no double counting.
- *Q: Why custom SVG instead of a chart library?* — A: One area chart with
  fixed requirements; zero dependencies, full control over dark styling and
  number formatting, no bundle cost.

---

## 7. Multi-device merge + OpenCode account sync

**Done:** Upsert by `(deviceId, day)`, summaries sum across devices; cloud
OpenCode rows (`cloud:opencode`) authoritative per day; coverage metadata
drives `Account-wide` vs `This device` badges with honest notes where no
account API exists.

**Challenge:** Two sources can describe the same day (local parse + cloud
export), and four of five providers have **no** account-level history API —
claiming "account-wide" for them would be fiction.

**Discovery:** I read the actual provider surfaces: OpenCode's usage-export
CSV (per-request tokens + charged micro-cents, 30d window), OpenAI docs
(Enterprise analytics only — personal Plus/Pro exposes quota %, never token
history), and T3 Code's source (transcript scanning per machine; its account
endpoint is quota windows only). So "account-wide without a local job" is
implementable for exactly one provider.

**Solution:** Server-side sync (service key, never in the browser) with
idempotent cloud upserts; local rows on exported days suppressed; everything
else keeps flowing from collectors. UI states the limitation per provider
instead of showing misleading zeros.

**Counter-questions:**
- *Q: What if cloud and local disagree on a day?* — A: Cloud wins for models
  the export covers (actual charged cost beats estimated table cost). Local is
  the only source for anything the export omits.
- *Q: Why is the export only 30 days?* — A: Provider-side limit; older history
  comes from collector backfills. Stated in the UI coverage note.
- *Q: Timezones — local day vs UTC cloud day?* — A: Collector buckets in
  local days, cloud rows in UTC days, stored as plain date strings. A day or
  two of boundary skew is possible and accepted; totals over ranges are
  unaffected.

---

## 8. Codex-via-OpenCode: proving single-counting

**Done:** Verified subscription-backed turns (Codex sub used inside OpenCode)
are counted exactly once, labeled `openai/<model>`, with cost-neutral pricing.

**Challenge:** The user (me) suspected double counting: the same logical turn
could plausibly appear in `~/.codex/sessions` (Codex bucket) and
`opencode.db` (OpenCode bucket) simultaneously.

**Discovery:** I joined both sources on exact
(day, model, input, cached, created, output) tuples across 9,039 Codex + 20,905
OpenCode records: **zero overlaps.** OpenCode never mirrors turns into Codex
rollouts. Separately, `providerID` in opencode.db showed 3,619 `gpt-5.6-sol`
turns backed by `openai` — correctly single-counted but mislabeled as plain
Zen usage.

**Solution:** No dedup code needed (nothing to dedupe). Added backing-provider
labels (`openai/gpt-5.6-sol`) for non-Zen rows, with pricing pinned to the bare
model id — caught by test when the label first shifted the matched rate
($272 → $136), fixed, re-verified at exactly $272.11.

**Counter-questions:**
- *Q: Why not bucket those turns under Codex?* — A: The recording tool is
  OpenCode and `providerID=openai` can't distinguish subscription-OAuth from a
  plain API key — rebucketing would mislabel and rewrite history. Labeling
  preserves truth at both levels.
- *Q: What if OpenCode later starts writing Codex rollouts?* — A: The overlap
  join is re-runnable in one command; if overlap appears, the fix is a
  source-preference rule (e.g. Codex rollouts win, opencode rows with
  providerID=openai suppressed on matching days).
- *Q: Empty cloud export — is sync broken?* — A: Verified working (HTTP 200,
  valid parse) but zero billable rows — consistent with free + subscription
  usage. The sync is a harmless no-op until Zen-billable usage exists.

---

## 9. No-clone distribution (npm + OpenCode command)

**Done:** `ai-usage-collector` on npm (zero deps, Bun or Node 22+), `bunx
ai-usage-collector@latest --push` from any folder; global `/sync-usage`
OpenCode command; repo-path scheduler files rewritten to `bunx`.

**Challenge:** The collector began life as repo-relative (`bun index.ts`, state
next to the clone, scheduler scripts with hardcoded paths) — unusable the
moment the repo isn't on the machine.

**Discovery:** Auditing imports showed pure Node builtins only (`node:sqlite`
with `bun:sqlite` fallback, no `Bun.*` APIs) — meaning it compiles with `tsc`
to dependency-free JS runnable anywhere. The only repo couplings were the
entry point, state location (already `$HOME`-based), and docs.

**Solution:** `bin` entry + `tsconfig.build.json` + `files: [dist, bin]`;
proved with a tarball installed into an empty dir and executed via plain
`node`. Publishing caught two real issues: npm normalizes `./bin/` prefixes
(fixed) and account 2FA requires `--otp` or a bypass token. Scheduler files
and the OpenCode command now invoke the package, never a path.

**Counter-questions:**
- *Q: Why npm instead of a single binary?* — A: Considered `bun build
  --compile`; npm won on updates (`@latest` always current, no re-download),
  cross-platform without build matrix, and the audience already has
  Bun/Node. Zero-dep keeps install instant.
- *Q: How do secrets work without the repo `.env`?* — A: Unchanged mechanism,
  new location: four env vars on the machine (persistent via OS env store).
  The OpenCode command refuses to run when they're absent and never echoes
  values.
- *Q: `tsc` caught errors Bun never did?* — A: Yes — three latent type errors
  (wrong map value type, duplicate spread key, untyped `bun:sqlite` import).
  Bun strips types without checking. Now `typecheck` gates every change.

---

## 10. Free-tier deployment

**Done:** Vercel Hobby + Turso free tier, $0/month; Root Directory `web/`;
Ignored Build Step so non-web pushes skip; twice-daily cron within Hobby's
daily-cadence limit.

**Challenge:** GitHub-linked deploys failed on every collector-only push, and
the cron schedule had to fit Hobby's once-per-day-per-expression limit.

**Discovery:** Repo root has no Next.js app and no `build` script — Vercel was
building the wrong directory. And Hobby rejects sub-daily cron expressions at
deploy time, so the "every 15 min" collector cadence could never live in
Vercel anyway (it stays a device-side concern).

**Solution:** Root Directory `web/`; `git diff HEAD^ HEAD --quiet -- web/`
as Ignored Build Step; two daily cron expressions (09:00 + 21:00 IST,
±59min Hobby jitter accepted and documented).

**Counter-questions:**
- *Q: Why not a VPS running everything?* — A: Overkill for append-mostly daily
  rows + 2 crons/day; managed cron + serverless + hosted SQLite removes all
  ops. `server/` (Hono + SQLite) is retained as the documented exit path.
- *Q: Turso free limits — will you outgrow them?* — A: ~40 rows/day
  equivalent; free tier allows orders of magnitude more reads/writes. Growth
  vector would be per-request rows, which the totals-only design avoids.
- *Q: Vercel Hobby commercial-use restriction?* — A: Personal project, fits
  Hobby terms; a team/commercial version would need Pro.

---

## 11. New-model guarantee + honest limitations

**Done:** Any new model name flows collector → API → all filters with zero
code changes (proven by fixture: unseen `zzq-new-model-2099` → exact name,
5,800 tokens kept, $0 unpriced). Antigravity family detection broadened from
4 to 14 prefixes so new families attribute correctly instead of collapsing
into the fallback.

**Challenge:** Model-name handling had three silent gates: an allowlist-shaped
regex (Antigravity), substring pricing that invents costs for lookalike names,
and UI consumers (cards summed the whole payload, footer read the day
snapshot) that ignored the range filter.

**Discovery:** Systematic audit of every touchpoint a model string passes
through, plus a fixture test for a name that exists nowhere in any table.

**Solution:** No model allowlists anywhere (only the provider enum, which is a
genuine code boundary); unknown → tokens kept + $0; all UI sections consume
the same range window. Boundary stated honestly: a brand-new *provider* still
needs a parser — that's inherent, not incidental.

**Say unprompted:** subscription dollars are API-equivalent estimates, never
bills; Antigravity is estimated; free-tier rows sort last at $0; cloud export
covers ~30 days.

---

## 12. Receipts (90-day run, this machine)

- Codex: ~1.09B tokens → **$312.98** API-equivalent (~4% off T3 Code).
- Grok: 14 turns → **$3.68** (exact T3 parity, $3.6771564 both sides).
- OpenCode: 1.7B Muse-Spark-contributor-free @ $0; 521M `openai/gpt-5.6-sol` →
  $272.11; 443M deepseek-v4-flash-free → $0.00 (post-fix).
- Overlap join: 0 shared turns across ~30k records (single-count proven).
- Server contracts 17/17; `next build`, `tsc --noEmit`, Bun bundle green.
