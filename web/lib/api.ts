export interface ProviderBucket {
  uncached: number; cached: number; cacheCreation: number; output: number;
  reasoning: number; totalTokens: number; costUsd: number; sessions: number; records: number;
}

export interface ModelRow {
  provider: string; model: string; totalTokens: number; costUsd: number; estimated?: boolean;
}

export interface DailyPoint {
  day: string;
  totalTokens: number;
  costUsd: number;
  byProvider: Record<string, { totalTokens: number; costUsd: number }>;
}

export interface Summary {
  requestedDay: string;
  day: string;
  isStale: boolean;
  lastPushAt: string | null;
  readAt: string;
  totalTokens: number;
  costUsd: number;
  sessions: number;
  byProvider: Record<string, ProviderBucket>;
  models: ModelRow[];
  rangeDays: number;
  daily: DailyPoint[];
  coverage?: Record<string, { mode: "account" | "device"; note: string; maxDays?: number; lastSyncAt?: string | null }>;
}

// NOTE: keep `process.env.NEXT_PUBLIC_*` as direct static member access.
// Next.js inlines those into the browser bundle at compile time; an
// indirection like `process.env[name]` is NOT inlined and reads as "".
export function apiBase(): string {
  return (
    process.env.NEXT_PUBLIC_API_URL ||
    process.env.VITE_API_URL ||
    ""
  ).replace(/\/$/, "");
}

export function readToken(): string {
  return process.env.NEXT_PUBLIC_READ_TOKEN || process.env.VITE_READ_TOKEN || "";
}

const KEY = "lastSummary";

function cacheKey(day: string, days: number): string {
  return `${KEY}:${day}:${days}`;
}

export function readCache(day: string, days: number): Summary | null {
  try {
    const raw = localStorage.getItem(cacheKey(day, days));
    if (!raw) return null;
    const s = JSON.parse(raw) as Summary;
    if (!s || !Array.isArray(s.daily)) return null;
    return s;
  } catch {
    return null;
  }
}

export function writeCache(s: Summary, day: string, days: number): void {
  try {
    localStorage.setItem(cacheKey(day, days), JSON.stringify(s));
  } catch { /* quota */ }
}

export async function fetchSummary(day: string, days: number, signal?: AbortSignal): Promise<Summary> {
  const base = apiBase();
  if (!base) throw new Error("API URL not configured");
  const r = await fetch(`${base}/v1/summary?day=${encodeURIComponent(day)}&days=${encodeURIComponent(days)}`, {
    headers: { Authorization: `Bearer ${readToken()}` },
    signal,
  });
  if (!r.ok) throw new Error(`API ${r.status}`);
  return (await r.json()) as Summary;
}
