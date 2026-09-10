import * as fs from "node:fs";
import * as path from "node:path";
import { createClient, type Client } from "@libsql/client";

// Storage adapter for the Vercel-hosted API. Same semantics as server/db.ts:
// totals-only rows, upsert by (deviceId, day).
// - Prod: Turso (libSQL over HTTP) via TURSO_DATABASE_URL + TURSO_AUTH_TOKEN.
// - Local dev: SQLite file via TURSO_DATABASE_URL=file:./data/usage.db (default).

export interface ProviderBucket {
  uncached: number; cached: number; cacheCreation: number; output: number;
  reasoning: number; totalTokens: number; costUsd: number; sessions: number; records: number;
}

export interface ModelRow {
  provider: string; model: string; totalTokens: number; costUsd: number; estimated?: boolean;
}

const PROVIDERS = ["codex", "claude", "grok", "opencode", "antigravity"] as const;

let _client: Client | null = null;

function dbUrl(): string {
  const raw = (process.env.TURSO_DATABASE_URL ?? "file:./data/usage.db").trim();
  // Tolerate bare filesystem paths ("./data/usage.db", "C:\data\u.db"):
  // libsql requires the file: scheme for local databases.
  if (raw === ":memory:" || raw.includes("://") || raw.startsWith("file:")) return raw;
  return `file:${raw}`;
}

function ensureLocalDir(url: string): void {
  if (!url.startsWith("file:")) return;
  const p = url.slice(5);
  if (p === ":memory:") return;
  fs.mkdirSync(path.dirname(path.resolve(p)), { recursive: true });
}

export function client(): Client {
  if (_client) return _client;
  const url = dbUrl();
  ensureLocalDir(url);
  _client = createClient({
    url,
    authToken: process.env.TURSO_AUTH_TOKEN || undefined,
  });
  return _client;
}

export async function init(): Promise<void> {
  await client().batch([
    `CREATE TABLE IF NOT EXISTS pushes (
      device_id TEXT NOT NULL,
      day TEXT NOT NULL,
      by_provider TEXT NOT NULL,
      models TEXT NOT NULL,
      pushed_at TEXT NOT NULL,
      PRIMARY KEY (device_id, day)
    )`,
    `CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
  ]);
}

export function zeroBucket(): ProviderBucket {
  return { uncached: 0, cached: 0, cacheCreation: 0, output: 0, reasoning: 0, totalTokens: 0, costUsd: 0, sessions: 0, records: 0 };
}

export function emptyProviders(): Record<string, ProviderBucket> {
  const o: Record<string, ProviderBucket> = {};
  for (const p of PROVIDERS) o[p] = zeroBucket();
  return o;
}

export async function upsertDay(
  deviceId: string, day: string,
  byProvider: Record<string, ProviderBucket>, models: ModelRow[], pushedAt: string,
): Promise<void> {
  // Sanitize: totals only. Drop unexpected keys that could carry PII.
  const clean: Record<string, ProviderBucket> = emptyProviders();
  for (const p of PROVIDERS) {
    const b = (byProvider as any)?.[p];
    if (!b || typeof b !== "object") continue;
    for (const k of ["uncached", "cached", "cacheCreation", "output", "reasoning", "totalTokens", "costUsd", "sessions", "records"] as const) {
      const n = Number((b as any)[k]);
      (clean[p] as any)[k] = Number.isFinite(n) && n >= 0 ? n : 0;
    }
  }
  const cleanModels = (Array.isArray(models) ? models : []).slice(0, 200).map((m: any) => ({
    provider: (PROVIDERS as readonly string[]).includes(m?.provider) ? m.provider : "unknown",
    model: String(m?.model ?? "unknown").slice(0, 120),
    totalTokens: Math.max(0, Number(m?.totalTokens) || 0),
    costUsd: Math.max(0, Number(m?.costUsd) || 0),
    ...(m?.estimated ? { estimated: true } : {}),
  }));
  const c = client();
  await c.execute({
    sql: `INSERT INTO pushes (device_id, day, by_provider, models, pushed_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (device_id, day) DO UPDATE SET by_provider=excluded.by_provider, models=excluded.models, pushed_at=excluded.pushed_at`,
    args: [deviceId, day, JSON.stringify(clean), JSON.stringify(cleanModels), pushedAt],
  });
  const last = await getMeta("lastPushAt");
  if (!last || pushedAt > last) await setMeta("lastPushAt", pushedAt);
}

export async function getMeta(key: string): Promise<string | null> {
  const r = await client().execute({ sql: `SELECT value FROM meta WHERE key=?`, args: [key] });
  return (r.rows[0]?.value as string) ?? null;
}

export async function setMeta(key: string, value: string): Promise<void> {
  await client().execute({
    sql: `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value=excluded.value`,
    args: [key, value],
  });
}

export async function lastDay(): Promise<string | null> {
  const r = await client().execute(`SELECT MAX(day) AS d FROM pushes`);
  return (r.rows[0]?.d as string) ?? null;
}

export interface DayAggregate {
  day: string;
  byProvider: Record<string, ProviderBucket>;
  models: ModelRow[];
}

export async function aggregateDay(day: string): Promise<DayAggregate> {
  const r = await client().execute({ sql: `SELECT device_id, by_provider, models FROM pushes WHERE day=?`, args: [day] });
  const hasOpencodeCloud = r.rows.some((row) => row.device_id === "cloud:opencode");
  const byProvider = emptyProviders();
  const modelMap = new Map<string, ModelRow>();
  for (const row of r.rows) {
    try {
      const bp = JSON.parse(row.by_provider as string) as Record<string, ProviderBucket>;
      for (const p of PROVIDERS) {
        if (p === "opencode" && hasOpencodeCloud && row.device_id !== "cloud:opencode") continue;
        const b = bp?.[p];
        if (!b) continue;
        for (const k of Object.keys(byProvider[p]) as Array<keyof ProviderBucket>) {
          (byProvider[p][k] as number) += Number((b as any)[k]) || 0;
        }
      }
    } catch { /* ignore bad row */ }
    try {
      const ms = JSON.parse(row.models as string) as ModelRow[];
      for (const m of ms) {
        if (m.provider === "opencode" && hasOpencodeCloud && row.device_id !== "cloud:opencode") continue;
        const key = `${m.provider}\0${m.model}`;
        if (!modelMap.has(key)) modelMap.set(key, { ...m, totalTokens: 0, costUsd: 0 });
        const acc = modelMap.get(key)!;
        acc.totalTokens += Number(m.totalTokens) || 0;
        acc.costUsd += Number(m.costUsd) || 0;
        acc.estimated = acc.estimated || (m as any).estimated;
      }
    } catch { /* ignore */ }
  }
  for (const p of PROVIDERS) byProvider[p].costUsd = Math.round(byProvider[p].costUsd * 10000) / 10000;
  const models = [...modelMap.values()]
    .map((m) => ({ ...m, costUsd: Math.round(m.costUsd * 10000) / 10000 }))
    .sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens);
  return { day, byProvider, models };
}

export async function latestDayAtOrBefore(day: string): Promise<string | null> {
  const r = await client().execute({ sql: `SELECT MAX(day) AS d FROM pushes WHERE day <= ?`, args: [day] });
  return (r.rows[0]?.d as string) ?? null;
}

export interface DailyPoint {
  day: string;
  totalTokens: number;
  costUsd: number;
  byProvider: Record<string, { totalTokens: number; costUsd: number }>;
  models: ModelRow[];
}

export async function dailySeries(days = 30, endDay?: string): Promise<DailyPoint[]> {
  const end = endDay ?? (await lastDay()) ?? new Date().toLocaleDateString("en-CA");
  const r = await client().execute({ sql: `SELECT device_id, day, by_provider, models FROM pushes WHERE day <= ? ORDER BY day DESC LIMIT ?`, args: [end, days * 4] });
  const opencodeCloudDays = new Set(
    r.rows.filter((row) => row.device_id === "cloud:opencode").map((row) => row.day as string),
  );
  const map = new Map<string, DailyPoint>();
  const modelMaps = new Map<string, Map<string, ModelRow>>();
  for (const row of r.rows) {
    try {
      const bp = JSON.parse(row.by_provider as string) as Record<string, ProviderBucket>;
      let acc = map.get(row.day as string);
      if (!acc) {
        const byProvider: DailyPoint["byProvider"] = {};
        for (const p of PROVIDERS) byProvider[p] = { totalTokens: 0, costUsd: 0 };
        acc = { day: row.day as string, totalTokens: 0, costUsd: 0, byProvider, models: [] };
        map.set(row.day as string, acc);
        modelMaps.set(row.day as string, new Map());
      }
      const cloudDay = opencodeCloudDays.has(row.day as string);
      for (const p of PROVIDERS) {
        if (p === "opencode" && cloudDay && row.device_id !== "cloud:opencode") continue;
        const t = Number(bp?.[p]?.totalTokens) || 0;
        const c = Number(bp?.[p]?.costUsd) || 0;
        acc.totalTokens += t; acc.costUsd += c;
        acc.byProvider[p].totalTokens += t;
        acc.byProvider[p].costUsd += c;
      }
      try {
        const ms = JSON.parse(row.models as string) as ModelRow[];
        const mm = modelMaps.get(row.day as string)!;
        for (const m of ms) {
          if (m.provider === "opencode" && cloudDay && row.device_id !== "cloud:opencode") continue;
          const key = `${m.provider}\0${m.model}`;
          if (!mm.has(key)) mm.set(key, { provider: m.provider, model: m.model, totalTokens: 0, costUsd: 0 });
          const a = mm.get(key)!;
          a.totalTokens += Number(m.totalTokens) || 0;
          a.costUsd += Number(m.costUsd) || 0;
          a.estimated = a.estimated || (m as any).estimated;
        }
      } catch { /* ignore bad models */ }
    } catch { /* ignore */ }
  }
  return [...map.values()]
    .sort((a, b) => (a.day < b.day ? -1 : 1))
    .slice(-days)
    .map((d) => ({
      ...d,
      costUsd: Math.round(d.costUsd * 10000) / 10000,
      byProvider: Object.fromEntries(
        Object.entries(d.byProvider).map(([p, v]) => [p, { ...v, costUsd: Math.round(v.costUsd * 10000) / 10000 }]),
      ),
      models: [...(modelMaps.get(d.day)?.values() ?? [])]
        .map((m) => ({ ...m, costUsd: Math.round(m.costUsd * 10000) / 10000 }))
        .sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens),
    }));
}
