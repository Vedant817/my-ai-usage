import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface ProviderBucket {
  uncached: number; cached: number; cacheCreation: number; output: number;
  reasoning: number; totalTokens: number; costUsd: number; sessions: number; records: number;
}

export interface ModelRow {
  provider: string; model: string; totalTokens: number; costUsd: number; estimated?: boolean;
}

const PROVIDERS = ["codex", "claude", "grok", "opencode", "antigravity"] as const;

function dbFile(): string {
  const url = process.env.DATABASE_URL ?? "./data/usage.db";
  const p = url.startsWith("file:") ? url.slice(5) : url;
  return p === ":memory:" ? ":memory:" : path.resolve(p);
}

let _db: DatabaseSync | null = null;

export function db(): DatabaseSync {
  if (_db) return _db;
  const file = dbFile();
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const d = new DatabaseSync(file);
  d.exec(`
    CREATE TABLE IF NOT EXISTS pushes (
      device_id TEXT NOT NULL,
      day TEXT NOT NULL,
      by_provider TEXT NOT NULL,
      models TEXT NOT NULL,
      pushed_at TEXT NOT NULL,
      PRIMARY KEY (device_id, day)
    );
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  _db = d;
  return d;
}

export function zeroBucket(): ProviderBucket {
  return { uncached: 0, cached: 0, cacheCreation: 0, output: 0, reasoning: 0, totalTokens: 0, costUsd: 0, sessions: 0, records: 0 };
}

export function emptyProviders(): Record<string, ProviderBucket> {
  const o: Record<string, ProviderBucket> = {};
  for (const p of PROVIDERS) o[p] = zeroBucket();
  return o;
}

export function upsertDay(deviceId: string, day: string, byProvider: Record<string, ProviderBucket>, models: ModelRow[], pushedAt: string): void {
  // Sanitize: totals only. Drop any unexpected keys that could carry PII.
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
    provider: PROVIDERS.includes(m?.provider) ? m.provider : "unknown",
    model: String(m?.model ?? "unknown").slice(0, 120),
    totalTokens: Math.max(0, Number(m?.totalTokens) || 0),
    costUsd: Math.max(0, Number(m?.costUsd) || 0),
    ...(m?.estimated ? { estimated: true } : {}),
  }));
  const d = db();
  d.prepare(
    `INSERT INTO pushes (device_id, day, by_provider, models, pushed_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (device_id, day) DO UPDATE SET by_provider=excluded.by_provider, models=excluded.models, pushed_at=excluded.pushed_at`,
  ).run(deviceId, day, JSON.stringify(clean), JSON.stringify(cleanModels), pushedAt);
  const last = getMeta("lastPushAt");
  if (!last || pushedAt > last) setMeta("lastPushAt", pushedAt);
}

export function getMeta(key: string): string | null {
  try {
    const r = db().prepare(`SELECT value FROM meta WHERE key=?`).get(key) as { value: string } | undefined;
    return r?.value ?? null;
  } catch {
    return null;
  }
}

export function setMeta(key: string, value: string): void {
  db().prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value=excluded.value`).run(key, value);
}

export function lastDay(): string | null {
  try {
    const r = db().prepare(`SELECT MAX(day) AS d FROM pushes`).get() as { d: string | null };
    return r?.d ?? null;
  } catch {
    return null;
  }
}

export interface DayAggregate {
  day: string;
  byProvider: Record<string, ProviderBucket>;
  models: ModelRow[];
}

export function aggregateDay(day: string): DayAggregate {
  const rows = db().prepare(`SELECT by_provider, models FROM pushes WHERE day=?`).all(day) as Array<{ by_provider: string; models: string }>;
  const byProvider = emptyProviders();
  const modelMap = new Map<string, ModelRow>();
  for (const r of rows) {
    try {
      const bp = JSON.parse(r.by_provider) as Record<string, ProviderBucket>;
      for (const p of PROVIDERS) {
        const b = bp?.[p];
        if (!b) continue;
        for (const k of Object.keys(byProvider[p]) as Array<keyof ProviderBucket>) {
          (byProvider[p][k] as number) += Number((b as any)[k]) || 0;
        }
      }
    } catch { /* ignore bad row */ }
    try {
      const ms = JSON.parse(r.models) as ModelRow[];
      for (const m of ms) {
        const key = `${m.provider}\0${m.model}`;
        if (!modelMap.has(key)) modelMap.set(key, { ...m, totalTokens: 0, costUsd: 0 });
        const acc = modelMap.get(key)!;
        acc.totalTokens += Number(m.totalTokens) || 0;
        acc.costUsd += Number(m.costUsd) || 0;
        acc.estimated = acc.estimated || (m as any).estimated;
      }
    } catch { /* ignore */ }
  }
  // Round for stable API output
  for (const p of PROVIDERS) byProvider[p].costUsd = Math.round(byProvider[p].costUsd * 10000) / 10000;
  const models = [...modelMap.values()]
    .map((m) => ({ ...m, costUsd: Math.round(m.costUsd * 10000) / 10000 }))
    .sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens);
  return { day, byProvider, models };
}

export function latestDayAtOrBefore(day: string): string | null {
  const r = db().prepare(`SELECT MAX(day) AS d FROM pushes WHERE day <= ?`).get(day) as { d: string | null };
  return r?.d ?? null;
}

export interface DailyPoint {
  day: string;
  totalTokens: number;
  costUsd: number;
  byProvider: Record<string, { totalTokens: number; costUsd: number }>;
  models: ModelRow[];
}

export function dailySeries(days = 30, endDay?: string): DailyPoint[] {
  const end = endDay ?? lastDay() ?? new Date().toLocaleDateString("en-CA");
  const rows = db().prepare(`SELECT device_id, day, by_provider, models FROM pushes WHERE day <= ? ORDER BY day DESC LIMIT ?`).all(end, days * 4) as Array<{ device_id: string; day: string; by_provider: string; models: string }>;
  const opencodeCloudDays = new Set(
    rows.filter((r) => r.device_id === "cloud:opencode").map((r) => r.day),
  );
  const map = new Map<string, DailyPoint>();
  const modelMaps = new Map<string, Map<string, ModelRow>>();
  for (const r of rows) {
    try {
      const bp = JSON.parse(r.by_provider) as Record<string, ProviderBucket>;
      let acc = map.get(r.day);
      if (!acc) {
        const byProvider: DailyPoint["byProvider"] = {};
        for (const p of PROVIDERS) byProvider[p] = { totalTokens: 0, costUsd: 0 };
        acc = { day: r.day, totalTokens: 0, costUsd: 0, byProvider, models: [] };
        map.set(r.day, acc);
        modelMaps.set(r.day, new Map());
      }
      const cloudDay = opencodeCloudDays.has(r.day);
      for (const p of PROVIDERS) {
        if (p === "opencode" && cloudDay && r.device_id !== "cloud:opencode") continue;
        const t = Number(bp?.[p]?.totalTokens) || 0;
        const c = Number(bp?.[p]?.costUsd) || 0;
        acc.totalTokens += t; acc.costUsd += c;
        acc.byProvider[p].totalTokens += t;
        acc.byProvider[p].costUsd += c;
      }
      try {
        const ms = JSON.parse(r.models) as ModelRow[];
        const mm = modelMaps.get(r.day)!;
        for (const m of ms) {
          if (m.provider === "opencode" && cloudDay && r.device_id !== "cloud:opencode") continue;
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
