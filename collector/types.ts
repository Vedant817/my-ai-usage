// Shared types. Privacy: only totals leave the PC. Never include prompts,
// completions, file contents, or absolute paths in payloads or logs.

export type Provider = "codex" | "claude" | "grok" | "opencode" | "antigravity" | "zed";

export const PROVIDERS: Provider[] = ["codex", "claude", "grok", "opencode", "antigravity", "zed"];

export interface UsageRecord {
  day: string; // YYYY-MM-DD (collector-local date)
  provider: Provider;
  model: string;
  uncached: number;
  cached: number;
  cacheCreation: number;
  output: number;
  reasoning: number;
  reportedCost: number | null;
  sessionId: string;
  dedupeKey: string;
  estimated?: boolean; // true for antigravity estimates
}

export interface ProviderStats {
  provider: Provider;
  scannedFiles: number;
  skipped: number;
  distinctSessions: number;
  records: number;
  note?: string;
}

export interface ParserResult {
  records: UsageRecord[];
  stats: ProviderStats;
}

export interface TokenBucket {
  uncached: number;
  cached: number;
  cacheCreation: number;
  output: number;
  reasoning: number;
  totalTokens: number;
  costUsd: number;
  sessions: number;
  records: number;
}

export interface ModelRow {
  provider: Provider;
  model: string;
  totalTokens: number;
  costUsd: number;
  estimated?: boolean;
}

export interface DayPayload {
  day: string;
  byProvider: Record<string, TokenBucket>;
  models: ModelRow[];
}

export interface IngestBody {
  deviceId: string;
  deviceLabel: string;
  pushedAt: string;
  days: DayPayload[];
}

export function emptyBucket(): TokenBucket {
  return {
    uncached: 0, cached: 0, cacheCreation: 0, output: 0,
    reasoning: 0, totalTokens: 0, costUsd: 0, sessions: 0, records: 0,
  };
}

export function dayOfLocal(tsMs: number): string {
  const d = new Date(tsMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function dayOffset(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return dayOfLocal(d.getTime());
}

export function parseDay(s: string): number {
  // YYYY-MM-DD -> ms at local midnight
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d).getTime();
}
