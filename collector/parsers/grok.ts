import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { dayOfLocal, type ParserResult, type UsageRecord } from "../types.js";
import { incrementalRange, markRead, mergeFileRecords, pruneFileRecords, walkFiles, type DashState } from "../state.js";

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function parseGrok(
  state: DashState,
  windowStartMs: number,
  dayFilter: (day: string) => boolean,
): ParserResult {
  const home = os.homedir();
  const root = process.env.GROK_DIR ?? path.join(home, ".grok", "sessions");
  const files = walkFiles([root], { fileName: "updates.jsonl", minMtimeMs: windowStartMs - 36 * 3600 * 1000 });
  const records: UsageRecord[] = [];
  const sessions = new Set<string>();
  const seen = new Set<string>();
  const liveKeys = new Set<string>();
  const startDay = dayOfLocal(windowStartMs);
  let skipped = 0;
  const slack = windowStartMs - 36 * 3600 * 1000;

  for (const file of files) {
    let st: fs.Stats;
    try { st = fs.statSync(file); } catch { skipped++; continue; }
    const key = `grok:${file}`;
    liveKeys.add(key);
    const { start, fresh } = incrementalRange(state, key, st.size, st.mtimeMs);
    if (fresh) {
      for (const r of mergeFileRecords(state, key, [], startDay)) {
        sessions.add(r.sessionId);
        records.push(r);
      }
      continue;
    }
    const freshRecs: UsageRecord[] = [];
    try {
      const fd = fs.openSync(file, "r");
      let text = "";
      try {
        const buf = Buffer.alloc(st.size - start);
        if (buf.length > 0) fs.readSync(fd, buf, 0, buf.length, start);
        text = buf.toString("utf8");
      } finally {
        fs.closeSync(fd);
      }
      for (const line of text.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        let obj: any;
        try { obj = JSON.parse(t); } catch { continue; }
        const update = obj?.params?.update;
        if (!update || update.sessionUpdate !== "turn_completed") continue;
        const sessionId = String(obj?.params?.sessionId ?? update.sessionId ?? path.basename(path.dirname(file)));
        const ts = Number(obj?.params?._meta?.agentTimestampMs
          ?? (typeof obj?.timestamp === "number" ? obj.timestamp * 1000 : NaN));
        const tsMs = Number.isFinite(ts) ? ts : st.mtimeMs;
        if (tsMs < slack) continue;
        const modelUsage = update.usage?.modelUsage ?? update.modelUsage ?? update.usage;
        if (!modelUsage || typeof modelUsage !== "object") continue;
        for (const [model, u] of Object.entries<any>(modelUsage)) {
          const promptId = String(update.prompt_id ?? update.promptId ?? update.turn_id ?? update.turnId ?? "");
          const key = `${sessionId}:${promptId}:${model}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const input = num(u.inputTokens ?? u.input_tokens);
          const output = num(u.outputTokens ?? u.output_tokens);
          const cached = num(u.cachedReadTokens ?? u.cached_input_tokens);
          const created = num(u.cacheCreationTokens ?? u.cache_creation_input_tokens);
          const reasoning = num(u.reasoningTokens ?? u.reasoning_output_tokens);
          const ticks = u.costUsdTicks ?? u.cost_usd_ticks ?? u.costTicks;
          const reported = ticks != null && Number.isFinite(Number(ticks)) ? Number(ticks) / 1e10 : null;
          if (!input && !output && !cached && !created && reported == null) continue;
          const day = dayOfLocal(tsMs);
          if (!dayFilter(day)) continue;
          sessions.add(sessionId);
          freshRecs.push({
            day, provider: "grok", model,
            uncached: Math.max(0, input - cached - created),
            cached, cacheCreation: created, output,
            reasoning: Math.min(reasoning, output),
            reportedCost: reported,
            sessionId, dedupeKey: key,
          });
        }
      }
      markRead(state, key, st.size, st.mtimeMs, st.size);
      for (const r of mergeFileRecords(state, key, freshRecs, startDay)) {
        sessions.add(r.sessionId);
        records.push(r);
      }
    } catch {
      skipped++;
    }
  }
  pruneFileRecords(state, liveKeys);

  return {
    records,
    stats: { provider: "grok", scannedFiles: files.length, skipped, distinctSessions: sessions.size, records: records.length },
  };
}
