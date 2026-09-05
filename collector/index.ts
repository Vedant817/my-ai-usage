#!/usr/bin/env bun
// Collector: PC files -> totals-only JSON -> POST /v1/ingest
// Privacy: prompts, completions, file contents, absolute paths NEVER leave PC.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PROVIDERS, dayOffset, emptyBucket, parseDay, type DayPayload, type IngestBody, type UsageRecord } from "./types.js";
import { loadState, saveState } from "./state.js";
import { Pricer } from "./pricing.js";
import { parseClaude } from "./parsers/claude.js";
import { parseCodex } from "./parsers/codex.js";
import { parseGrok } from "./parsers/grok.js";
import { parseOpencode } from "./parsers/opencode.js";
import { parseAntigravity } from "./parsers/antigravity.js";

function loadEnv(): void {
  for (const f of [path.join(process.cwd(), ".env"), path.join(process.cwd(), "collector", ".env")]) {
    try {
      const raw = fs.readFileSync(f, "utf8");
      for (const line of raw.split("\n")) {
        const t = line.trim();
        if (!t || t.startsWith("#") || !t.includes("=")) continue;
        const i = t.indexOf("=");
        const k = t.slice(0, i).trim();
        let v = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
        if (!(k in process.env)) process.env[k] = v;
      }
    } catch { /* no .env */ }
  }
}

interface Args {
  days: number;
  dryRun: boolean;
  push: boolean;
  dataDir?: string;
  help: boolean;
}

function parseArgs(): Args {
  const a: Args = { days: 30, dryRun: false, push: false, help: false };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--dry-run") a.dryRun = true;
    else if (t === "--push") a.push = true;
    else if (t === "--help" || t === "-h") a.help = true;
    else if (t === "--days" && argv[i + 1]) a.days = Math.max(1, Math.min(365, Number(argv[++i]) || 30));
    else if (t.startsWith("--days=")) a.days = Math.max(1, Math.min(365, Number(t.split("=")[1]) || 30));
    else if (t === "--data-dir" && argv[i + 1]) a.dataDir = argv[++i];
    else if (t.startsWith("--data-dir=")) a.dataDir = t.split("=").slice(1).join("=");
  }
  if (!a.dryRun && !a.push) a.dryRun = true; // safe default
  if (a.push) a.dryRun = false;
  return a;
}

async function fetchLastDay(apiUrl: string, ingestToken: string): Promise<string | null> {
  // Backfill anchor: ask server for last pushed day. Fail soft (offline -> null).
  try {
    // last-day is a read endpoint but ingest token is accepted too (server allows either).
    for (const token of [process.env.READ_TOKEN, ingestToken].filter(Boolean) as string[]) {
      try {
        const r = await fetch(apiUrl.replace(/\/$/, "") + "/v1/last-day", {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(8000),
        });
        if (r.ok) {
          const j = (await r.json()) as { lastDay?: string | null };
          if (j?.lastDay) return j.lastDay;
        }
      } catch { /* try next token */ }
    }
    return null;
  } catch {
    return null;
  }
}

function aggregate(records: UsageRecord[], pricer: Pricer, allowedDays: Set<string>): DayPayload[] {
  // Dedupe globally by provider+dedupeKey (keeps incremental re-reads idempotent).
  const seen = new Set<string>();
  const byDay = new Map<string, UsageRecord[]>();
  for (const r of records) {
    if (!allowedDays.has(r.day)) continue;
    const k = `${r.provider}:${r.dedupeKey}`;
    if (seen.has(k)) continue;
    seen.add(k);
    if (!byDay.has(r.day)) byDay.set(r.day, []);
    byDay.get(r.day)!.push(r);
  }
  const days: DayPayload[] = [];
  for (const day of [...byDay.keys()].sort()) {
    const list = byDay.get(day)!;
    const byProvider: DayPayload["byProvider"] = {};
    const modelMap = new Map<string, { provider: string; model: string; totalTokens: number; costUsd: number; estimated: boolean }>();
    const sessByProv = new Map<string, Set<string>>();
    for (const r of list) {
      const total = r.uncached + r.cached + r.cacheCreation + r.output;
      let cost = 0;
      let estimated = !!r.estimated;
      if (estimated) {
        cost = pricer.priceEstimated(r.model, r);
      } else if (r.reportedCost != null && r.reportedCost > 0) {
        cost = r.reportedCost;
      } else {
        const p = pricer.price(r.model, r, null);
        cost = p.costUsd;
      }
      if (!byProvider[r.provider]) byProvider[r.provider] = { ...emptyBucket() };
      const b = byProvider[r.provider];
      b.uncached += r.uncached; b.cached += r.cached; b.cacheCreation += r.cacheCreation;
      b.output += r.output; b.reasoning += Math.min(r.reasoning, r.output);
      b.totalTokens += total; b.costUsd += cost; b.records += 1;
      if (!sessByProv.has(r.provider)) sessByProv.set(r.provider, new Set());
      sessByProv.get(r.provider)!.add(r.sessionId);
      const mk = `${r.provider}\0${r.model}`;
      if (!modelMap.has(mk)) modelMap.set(mk, { provider: r.provider, model: r.model, totalTokens: 0, costUsd: 0, estimated });
      const mm = modelMap.get(mk)!;
      mm.totalTokens += total; mm.costUsd += cost; mm.estimated = mm.estimated || estimated;
    }
    for (const [prov, set] of sessByProv) byProvider[prov].sessions = set.size;
    // Round costs to 4dp for stable payloads
    for (const b of Object.values(byProvider)) b.costUsd = Math.round(b.costUsd * 10000) / 10000;
    const models = [...modelMap.values()]
      .map((m) => ({ ...m, costUsd: Math.round(m.costUsd * 10000) / 10000 }))
      .sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens);
    days.push({ day, byProvider, models });
  }
  return days;
}

async function main(): Promise<void> {
  loadEnv();
  const args = parseArgs();
  if (args.help) {
    console.log(`usage-dash collector\n\n  collector --days 30 --dry-run\n  collector --push [--days 30] [--data-dir <dir>]\n\nPrivacy: only {day, provider, model, token counts, costUsd, sessions, records} leave the PC.`);
    process.exit(0);
  }

  const { state, path: statePath } = loadState(args.dataDir);
  const apiUrl = (process.env.API_URL ?? "").replace(/\/$/, "");
  const ingestToken = process.env.INGEST_TOKEN ?? "";
  const deviceId = process.env.DEVICE_ID ?? os.hostname();
  const deviceLabel = process.env.DEVICE_LABEL ?? os.hostname();

  // Window: today - days, minus 36h slack for late-written files.
  let startDay = dayOffset(args.days - 1);
  if (args.push && apiUrl && ingestToken) {
    const last = await fetchLastDay(apiUrl, ingestToken);
    if (last && last < startDay) startDay = last; // backfill from last pushed day
    if (last) state.lastPushDay = state.lastPushDay ?? last;
  }
  const windowStartMs = parseDay(startDay);
  const endDay = dayOffset(0);
  const allowed = new Set<string>();
  {
    const s = parseDay(startDay);
    const e = parseDay(endDay) + 24 * 3600 * 1000;
    for (let t = s; t < e; t += 24 * 3600 * 1000) {
      allowed.add(new Date(t).toLocaleDateString("en-CA"));
    }
  }
  const dayFilter = (d: string) => allowed.has(d);

  const pricer = await Pricer.load();

  // Run all 5 providers; one failure never fails the whole run.
  const results: Array<{ records: UsageRecord[]; stats: { provider: any; scannedFiles: number; skipped: number; distinctSessions: number; records: number; note?: string } }> = [];
  const run = async (fn: () => any, name: string) => {
    try {
      results.push(await fn());
    } catch (e) {
      results.push({
        records: [] as UsageRecord[],
        stats: { provider: name as any, scannedFiles: 0, skipped: 0, distinctSessions: 0, records: 0, note: `parser crashed (non-fatal): ${e instanceof Error ? e.message : String(e)}` },
      });
    }
  };
  await run(() => parseClaude(state, windowStartMs, dayFilter), "claude");
  await run(() => parseCodex(state, windowStartMs, dayFilter), "codex");
  await run(() => parseGrok(state, windowStartMs, dayFilter), "grok");
  await run(() => parseOpencode(state, windowStartMs, dayFilter), "opencode");
  await run(() => parseAntigravity(state, windowStartMs, dayFilter), "antigravity");

  const allRecords = results.flatMap((r) => r.records);
  // Ensure every provider appears in output even when zero.
  const days = aggregate(allRecords, pricer, allowed);
  for (const d of days) {
    for (const p of PROVIDERS) {
      if (!d.byProvider[p]) d.byProvider[p] = { ...emptyBucket() };
    }
  }

  const body: IngestBody = {
    deviceId, deviceLabel,
    pushedAt: new Date().toISOString(),
    days,
  };

  // Per-provider log (counts only, no paths/prompts).
  for (const r of results) {
    console.log(JSON.stringify({ provider: r.stats.provider, ...r.stats }));
  }
  console.log(JSON.stringify({
    days: days.length, range: days.length ? `${days[0].day}..${days[days.length - 1].day}` : "empty",
    pricing: pricer.source + (pricer.stale ? " (stale)" : ""),
  }));

  if (args.dryRun || !args.push) {
    console.log(JSON.stringify(body, null, 2));
    saveState(statePath, state);
    return;
  }

  if (!apiUrl || !ingestToken) {
    console.error("Missing API_URL or INGEST_TOKEN (see collector/.env.example). Payload not uploaded; state saved.");
    saveState(statePath, state);
    process.exit(0);
  }
  const res = await fetch(apiUrl + "/v1/ingest", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${ingestToken}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    console.error(`ingest failed: HTTP ${res.status} ${(await res.text()).slice(0, 500)}`);
    saveState(statePath, state);
    process.exit(0); // cron-friendly: exit 0, next tick retries (backfill covers gap)
  }
  if (days.length) state.lastPushDay = days[days.length - 1].day;
  saveState(statePath, state);
  console.log(JSON.stringify({ ok: true, pushedDays: days.length }));
}

main().catch((e) => {
  console.error(`collector fatal (non-zero suppressed for cron): ${e instanceof Error ? e.message : String(e)}`);
  process.exit(0);
});
