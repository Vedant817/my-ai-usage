export interface ProviderBucket {
  uncached: number; cached: number; cacheCreation: number; output: number;
  reasoning: number; totalTokens: number; costUsd: number; sessions: number; records: number;
}

export interface ModelRow {
  provider: string; model: string; totalTokens: number; costUsd: number; estimated?: boolean;
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
  daily: Array<{ day: string; totalTokens: number; costUsd: number }>;
}

function env(name: string): string {
  return (process.env[name] ?? "") as string;
}

export function apiBase(): string {
  return (
    env("NEXT_PUBLIC_API_URL") ||
    (typeof window !== "undefined" ? (window as unknown as Record<string, string | undefined>).__API_URL__ ?? "" : "") ||
    env("VITE_API_URL") ||
    ""
  ).replace(/\/$/, "");
}

export function readToken(): string {
  return env("NEXT_PUBLIC_READ_TOKEN") || env("VITE_READ_TOKEN") || "";
}

const KEY = "lastSummary";

export function readCache(): Summary | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    return JSON.parse(raw) as Summary;
  } catch {
    return null;
  }
}

export function writeCache(s: Summary): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch { /* quota */ }
}

export async function fetchSummary(day: string, signal?: AbortSignal): Promise<Summary> {
  const base = apiBase();
  if (!base) throw new Error("API URL not configured");
  const r = await fetch(`${base}/v1/summary?day=${encodeURIComponent(day)}`, {
    headers: { Authorization: `Bearer ${readToken()}` },
    signal,
  });
  if (!r.ok) throw new Error(`API ${r.status}`);
  return (await r.json()) as Summary;
}
