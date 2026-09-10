import { init, setMeta, upsertDay } from "./store";

// Account-level usage sync: pulls provider billing APIs server-side so usage
// is consistent across devices with NO collector job on any PC.
//
// Supported today:
// - opencode: GET {console}/api/v1/usage/export (service key oc_sk_...),
//   per-request tokens + actual charged cost, ranges 24h/7d/30d.
// Not feasible (no public usage API for subscriptions):
// - ChatGPT/Codex subscription, Claude Pro/Max, SuperGrok/Grok subscription,
//   Zed, Antigravity free tier -> keep the local collector for those.

export interface SyncResult {
  provider: string;
  ok: boolean;
  days: number;
  records: number;
  skipped?: string;
  error?: string;
}

function consoleBase(): string {
  return (process.env.OPENCODE_CONSOLE_URL ?? "https://opencode.ai/console").replace(/\/$/, "");
}

/** Minimal RFC-4180 CSV parse (handles quoted commas/quotes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c === "\r") { /* skip */ }
    else field += c;
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0].trim() !== ""));
}

function num(v: string | undefined): number {
  const n = Number((v ?? "").trim());
  return Number.isFinite(n) && n > 0 ? n : 0;
}

interface CloudRow {
  day: string; // UTC date
  model: string;
  input: number; output: number;
  cached: number; created: number; reasoning: number;
  costUsd: number;
}

function toDayPayloads(rows: CloudRow[]): Array<{
  day: string;
  byProvider: Record<string, { uncached: number; cached: number; cacheCreation: number; output: number; reasoning: number; totalTokens: number; costUsd: number; sessions: number; records: number }>;
  models: Array<{ provider: string; model: string; totalTokens: number; costUsd: number }>;
}> {
  const byDay = new Map<string, CloudRow[]>();
  for (const r of rows) {
    if (!byDay.has(r.day)) byDay.set(r.day, []);
    byDay.get(r.day)!.push(r);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([day, list]) => {
      const bucket = { uncached: 0, cached: 0, cacheCreation: 0, output: 0, reasoning: 0, totalTokens: 0, costUsd: 0, sessions: 0, records: 0 };
      const modelMap = new Map<string, { provider: string; model: string; totalTokens: number; costUsd: number }>();
      for (const r of list) {
        const uncached = Math.max(0, r.input - r.cached - r.created);
        const total = uncached + r.cached + r.created + r.output;
        bucket.uncached += uncached; bucket.cached += r.cached; bucket.cacheCreation += r.created;
        bucket.output += r.output; bucket.reasoning += Math.min(r.reasoning, r.output);
        bucket.totalTokens += total; bucket.costUsd += r.costUsd; bucket.records += 1;
        const key = `opencode\0${r.model}`;
        if (!modelMap.has(key)) modelMap.set(key, { provider: "opencode", model: r.model, totalTokens: 0, costUsd: 0 });
        const m = modelMap.get(key)!;
        m.totalTokens += total; m.costUsd += r.costUsd;
      }
      bucket.costUsd = Math.round(bucket.costUsd * 10000) / 10000;
      return {
        day,
        byProvider: { opencode: bucket },
        models: [...modelMap.values()]
          .map((m) => ({ ...m, costUsd: Math.round(m.costUsd * 10000) / 10000 }))
          .sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens),
      };
    });
}

async function fetchExportCsv(base: string, key: string): Promise<string> {
  const url = `${base}/api/v1/usage/export?${new URLSearchParams({ scope: "organization", range: "30d" })}`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${key}`, Accept: "text/csv" },
    signal: AbortSignal.timeout(45000),
  });
  if (!r.ok) throw new Error(`export HTTP ${r.status}`);
  return await r.text();
}

export async function syncOpencode(): Promise<SyncResult> {
  const key = (process.env.OPENCODE_SERVICE_KEY ?? "").trim();
  if (!key) return { provider: "opencode", ok: false, days: 0, records: 0, skipped: "no OPENCODE_SERVICE_KEY" };
  const bases = [consoleBase()];
  if (bases[0].includes("opencode.ai/console")) bases.push("https://console.opencode.ai");
  else if (bases[0].includes("console.opencode.ai")) bases.push("https://opencode.ai/console");

  let csv: string | null = null;
  let lastErr = "";
  for (const b of bases) {
    try {
      csv = await fetchExportCsv(b, key);
      break;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  if (csv == null) return { provider: "opencode", ok: false, days: 0, records: 0, error: lastErr };

  const table = parseCsv(csv);
  if (table.length < 2) return { provider: "opencode", ok: true, days: 0, records: 0 };
  const head = table[0].map((h) => h.trim().toLowerCase());
  const col = (name: string) => head.indexOf(name);
  const ci = {
    model: col("model"), input: col("input_tokens"), output: col("output_tokens"),
    reasoning: col("reasoning_tokens"), cached: col("cache_read_tokens"),
    cw5: col("cache_write_5m_tokens"), cw1: col("cache_write_1h_tokens"),
    cost: col("cost_micro_cents"), created: col("created_at"),
  };
  if (ci.model < 0 || ci.input < 0 || ci.output < 0 || ci.created < 0) {
    return { provider: "opencode", ok: false, days: 0, records: 0, error: "unexpected CSV columns" };
  }
  const rows: CloudRow[] = [];
  for (const line of table.slice(1)) {
    const get = (i: number) => (i >= 0 ? line[i] : "");
    const ts = Date.parse((get(ci.created) ?? "").trim());
    if (!Number.isFinite(ts)) continue;
    const input = num(get(ci.input)), output = num(get(ci.output));
    const cached = num(get(ci.cached)), created = num(get(ci.cw5)) + num(get(ci.cw1));
    const cost = ci.cost >= 0 ? num(get(ci.cost)) / 1e8 : 0;
    if (!input && !output && !cached && !created && !cost) continue;
    rows.push({
      day: new Date(ts).toISOString().slice(0, 10), // UTC day (cloud source)
      model: (get(ci.model) || "unknown").trim().slice(0, 120) || "unknown",
      input, output, cached, created,
      reasoning: num(get(ci.reasoning)),
      costUsd: cost,
    });
  }

  await init();
  const pushedAt = new Date().toISOString();
  const payloads = toDayPayloads(rows);
  for (const d of payloads) {
    await upsertDay("cloud:opencode", d.day, d.byProvider as never, d.models, pushedAt);
  }
  await setMeta("sync:opencode:lastAt", pushedAt);
  return { provider: "opencode", ok: true, days: payloads.length, records: rows.length };
}

/** Run every configured provider sync. Never throws. */
export async function runProviderSync(): Promise<SyncResult[]> {
  const out: SyncResult[] = [];
  try {
    out.push(await syncOpencode());
  } catch (e) {
    out.push({ provider: "opencode", ok: false, days: 0, records: 0, error: e instanceof Error ? e.message : String(e) });
  }
  return out;
}
