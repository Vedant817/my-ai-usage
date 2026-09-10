import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { dayOfLocal, type ParserResult, type UsageRecord } from "../types.js";
import { incrementalRange, markRead, mergeFileRecords, pruneFileRecords, walkFiles, type DashState } from "../state.js";

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Wire semantics (xai-org/grok-build and t3code): each turn_completed carries
// that turn's own usage, with cost in 1e10 ticks = $1.
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
  let skipped = 0;
  const slack = windowStartMs - 36 * 3600 * 1000;

  for (const file of files) {
    let st: fs.Stats;
    try { st = fs.statSync(file); } catch { skipped++; continue; }
    // Versioned key re-baselines records after adopting T3 Code's exact cost
    // allocation and deduplication behavior.
    const key = `grok-v2:${file}`;
    liveKeys.add(key);
    const { start, fresh } = incrementalRange(state, key, st.size, st.mtimeMs);
    if (fresh) {
      for (const r of mergeFileRecords(state, key, [])) {
        sessions.add(r.sessionId);
        records.push(r);
      }
      continue;
    }
    const freshRecs: UsageRecord[] = [];
    const pushFresh = (r: UsageRecord) => {
      if (seen.has(r.dedupeKey)) return;
      seen.add(r.dedupeKey);
      freshRecs.push(r);
    };
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
        // Per-model breakdowns live under usage.modelUsage; the top-level
        // usage object itself is totals, never a model (t3code parity).
        const muSource = update.usage?.modelUsage ?? update.modelUsage;
        const modelEntries: Array<[string, any]> =
          muSource && typeof muSource === "object"
            ? Object.entries(muSource).filter(([m, u]) => m.length > 0 && u !== null && typeof u === "object")
            : [];
        const promptId = String(update.prompt_id ?? update.promptId ?? update.turn_id ?? update.turnId ?? "");
        const day = dayOfLocal(tsMs);
        if (!dayFilter(day)) continue;
        const readTotals = (u: any) => {
          const input = num(u.inputTokens ?? u.input_tokens);
          const output = num(u.outputTokens ?? u.output_tokens);
          const cached = num(u.cachedReadTokens ?? u.cached_input_tokens);
          const created = num(u.cacheCreationTokens ?? u.cache_creation_input_tokens);
          const reasoning = num(u.reasoningTokens ?? u.reasoning_output_tokens);
          return { input, output, cached, created, reasoning };
        };
        const readCost = (ticks: unknown): number | null =>
          typeof ticks === "number" && Number.isFinite(ticks) ? ticks / 1e10 : null;
        const pushTotals = (model: string, u: any, reported: number | null, key: string) => {
          const { input, output, cached, created, reasoning } = readTotals(u);
          if (!input && !output && !cached && !created) return;
          sessions.add(sessionId);
          pushFresh({
            day, provider: "grok", model,
            uncached: Math.max(0, input - cached - created),
            cached, cacheCreation: created, output,
            reasoning: Math.min(reasoning, output),
            reportedCost: reported,
            sessionId, dedupeKey: key,
          });
        };
        if (modelEntries.length === 0) {
          // No per-model split: single record from turn totals (model "grok").
          const u = update.usage ?? {};
          const key = promptId ? `${sessionId}:${promptId}:grok` : `${sessionId}:grok:${tsMs}`;
          pushTotals("grok", u, readCost(u.costUsdTicks ?? u.cost_usd_ticks ?? u.costTicks), key);
          continue;
        }
        const top = update.usage ?? {};
        const topCost = readCost(top.costUsdTicks ?? top.cost_usd_ticks ?? top.costTicks);
        let usedCost = 0;
        let untickedTokens = 0;
        for (const [, u] of modelEntries) {
          const t = readTotals(u);
          const tokens = Math.max(0, t.input - t.cached - t.created) + t.cached + t.created + t.output;
          if (tokens === 0) continue;
          const cost = readCost(u.costUsdTicks ?? u.cost_usd_ticks ?? u.costTicks);
          if (cost === null) untickedTokens += tokens;
          else usedCost += cost;
        }
        const remainingCost = topCost === null ? null : Math.max(0, topCost - usedCost);
        for (const [model, u] of modelEntries) {
          const t = readTotals(u);
          const tokens = Math.max(0, t.input - t.cached - t.created) + t.cached + t.created + t.output;
          let cost = readCost(u.costUsdTicks ?? u.cost_usd_ticks ?? u.costTicks);
          if (cost === null && remainingCost !== null && untickedTokens > 0) {
            cost = remainingCost * (tokens / untickedTokens);
          }
          const key = promptId ? `${sessionId}:${promptId}:${model}` : `${sessionId}:${model}:${tsMs}`;
          pushTotals(model, u, cost, key);
        }
      }
      markRead(state, key, st.size, st.mtimeMs, st.size);
      for (const r of mergeFileRecords(state, key, freshRecs)) {
        sessions.add(r.sessionId);
        records.push(r);
      }
    } catch {
      skipped++;
    }
  }
  pruneFileRecords(state, new Set(), "grok:");
  pruneFileRecords(state, liveKeys, "grok-v2:");
  for (const key of Object.keys(state.fileCache)) {
    if (key.startsWith("grok:")) delete state.fileCache[key];
  }

  return {
    records,
    stats: { provider: "grok", scannedFiles: files.length, skipped, distinctSessions: sessions.size, records: records.length },
  };
}
