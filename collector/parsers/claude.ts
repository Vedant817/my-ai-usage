import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { dayOfLocal, type ParserResult, type UsageRecord } from "../types.js";
import { incrementalRange, markRead, mergeFileRecords, pruneFileRecords, walkFiles, type DashState } from "../state.js";

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function toMs(ts: unknown): number | null {
  if (typeof ts === "number" && Number.isFinite(ts)) {
    return ts < 1e12 ? ts * 1000 : ts; // seconds -> ms
  }
  if (typeof ts === "string") {
    const m = Date.parse(ts);
    return Number.isFinite(m) ? m : null;
  }
  return null;
}

export function parseClaude(
  state: DashState,
  windowStartMs: number,
  dayFilter: (day: string) => boolean,
): ParserResult {
  const home = os.homedir();
  const roots = [
    path.join(home, ".claude", "projects"),
    path.join(home, ".claude", "transcripts"),
    path.join(home, ".claude", "sessions"),
  ].filter((r) => {
    try { return fs.statSync(r).isDirectory(); } catch { return false; }
  });
  // Also support custom transcript roots via env (tests).
  if (process.env.CLAUDE_DIR) roots.push(process.env.CLAUDE_DIR);

  const files = walkFiles(roots, { extensions: [".jsonl"], minMtimeMs: windowStartMs - 36 * 3600 * 1000 });
  const records: UsageRecord[] = [];
  const sessions = new Set<string>();
  const seen = new Set<string>();
  const liveKeys = new Set<string>();
  const startDay = dayOfLocal(windowStartMs);
  let skipped = 0;

  for (const file of files) {
    let st: fs.Stats;
    try { st = fs.statSync(file); } catch { skipped++; continue; }
    const key = `claude:${file}`;
    liveKeys.add(key);
    const { start, fresh } = incrementalRange(state, key, st.size, st.mtimeMs);
    if (fresh) {
      // Unchanged on disk: serve this file's cached contribution so day totals stay full.
      for (const r of mergeFileRecords(state, key, [], startDay)) {
        sessions.add(r.sessionId);
        records.push(r);
      }
      continue;
    }
    const freshRecs: UsageRecord[] = [];
    let fd: number | null = null;
    try {
      fd = fs.openSync(file, "r");
      const buf = Buffer.alloc(st.size - start);
      if (buf.length > 0) fs.readSync(fd, buf, 0, buf.length, start);
      const text = buf.toString("utf8");
      for (const line of text.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        let obj: any;
        try { obj = JSON.parse(t); } catch { continue; }
        if (obj?.type !== "assistant") continue;
        const usage = obj?.message?.usage;
        if (!usage) continue;
        const ts = toMs(obj.timestamp ?? obj.message?.timestamp) ?? st.mtimeMs;
        if (ts < windowStartMs - 36 * 3600 * 1000) continue;
        const day = dayOfLocal(ts);
        if (!dayFilter(day)) continue;
        const model = String(obj?.message?.model ?? obj?.model ?? "unknown");
        const dedupe = `${String(obj?.message?.id ?? "")}:${String(obj?.requestId ?? obj?.request_id ?? "")}`;
        if (dedupe !== ":" && seen.has(dedupe)) continue;
        if (dedupe !== ":") seen.add(dedupe);
        const sessionId = String(obj.sessionId ?? obj.session_id ?? path.basename(file));
        const input = num(usage.input_tokens);
        const cached = num(usage.cache_read_input_tokens);
        const created = num(usage.cache_creation_input_tokens);
        const output = num(usage.output_tokens);
        if (!input && !cached && !created && !output) continue;
        const cost = obj.costUSD != null ? Number(obj.costUSD) : (usage.costUSD != null ? Number(usage.costUSD) : null);
        sessions.add(sessionId);
        freshRecs.push({
          day, provider: "claude", model,
          uncached: Math.max(0, input - cached - created),
          cached, cacheCreation: created, output,
          reasoning: 0,
          reportedCost: cost != null && Number.isFinite(cost) ? cost : null,
          sessionId, dedupeKey: dedupe || `${file}:${ts}:${model}`,
        });
      }
      markRead(state, key, st.size, st.mtimeMs, st.size);
      for (const r of mergeFileRecords(state, key, freshRecs, startDay)) {
        sessions.add(r.sessionId);
        records.push(r);
      }
    } catch {
      skipped++;
    } finally {
      if (fd != null) try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
  pruneFileRecords(state, liveKeys);

  return {
    records,
    stats: { provider: "claude", scannedFiles: files.length, skipped, distinctSessions: sessions.size, records: records.length },
  };
}
