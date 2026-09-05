import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { dayOfLocal, type ParserResult, type UsageRecord } from "../types.js";
import { incrementalRange, markRead, walkFiles, type DashState } from "../state.js";

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function toMs(ts: unknown, fallback: number): number {
  if (typeof ts === "number" && Number.isFinite(ts)) return ts < 1e12 ? ts * 1000 : ts;
  if (typeof ts === "string") {
    const m = Date.parse(ts);
    if (Number.isFinite(m)) return m;
  }
  return fallback;
}

export function parseCodex(
  state: DashState,
  windowStartMs: number,
  dayFilter: (day: string) => boolean,
): ParserResult {
  const home = os.homedir();
  const root = process.env.CODEX_HOME
    ? path.join(process.env.CODEX_HOME, "sessions")
    : path.join(home, ".codex", "sessions");
  const files = walkFiles([root], { extensions: [".jsonl"], minMtimeMs: windowStartMs - 36 * 3600 * 1000 });
  const records: UsageRecord[] = [];
  const sessions = new Set<string>();
  let skipped = 0;

  for (const file of files) {
    let st: fs.Stats;
    try { st = fs.statSync(file); } catch { skipped++; continue; }
    const { start, fresh } = incrementalRange(state, `codex:${file}`, st.size, st.mtimeMs);
    if (fresh) { skipped++; continue; }
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
      let sessionId = "";
      let model = "";
      let prevSig = "";
      for (const line of text.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        let obj: any;
        try { obj = JSON.parse(t); } catch { continue; }
        const type = String(obj?.type ?? "");
        if (type === "session_meta") {
          sessionId = String(obj?.payload?.id ?? sessionId);
          continue;
        }
        if (type === "turn_context") {
          const m = obj?.payload?.model ?? obj?.payload?.model_name;
          if (m) model = String(m);
          continue;
        }
        const payload = obj?.payload;
        if (payload?.type !== "token_count") continue;
        if (!model) continue; // skip if no model yet
        const info = payload?.info?.last_token_usage ?? payload?.info ?? payload?.usage;
        if (!info) continue;
        const input = num(info.input_tokens ?? info.inputTokens);
        const cached = num(info.cached_input_tokens ?? info.cachedInputTokens);
        const cacheWrite = num(info.cache_write_input_tokens ?? info.cacheWriteInputTokens ?? info.cache_creation_input_tokens);
        const output = num(info.output_tokens ?? info.outputTokens);
        const reasoning = num(info.reasoning_output_tokens ?? info.reasoningTokens ?? info.reasoning_output);
        if (!input && !cached && !cacheWrite && !output) continue;
        const sig = JSON.stringify([model, input, cached, cacheWrite, output, reasoning]);
        if (sig === prevSig) continue; // dedupe consecutive identical
        prevSig = sig;
        const ts = toMs(obj.timestamp, st.mtimeMs);
        if (ts < windowStartMs - 36 * 3600 * 1000) continue;
        const day = dayOfLocal(ts);
        if (!dayFilter(day)) continue;
        const sid = sessionId || path.basename(file, ".jsonl");
        sessions.add(sid);
        records.push({
          day, provider: "codex", model,
          uncached: Math.max(0, input - cached - cacheWrite),
          cached, cacheCreation: cacheWrite, output,
          reasoning: Math.min(reasoning, output),
          reportedCost: null, // priced via table
          sessionId: sid,
          dedupeKey: `${sid}:${ts}:${sig}`,
        });
      }
      markRead(state, `codex:${file}`, st.size, st.mtimeMs, st.size);
    } catch {
      skipped++;
    }
  }

  return {
    records,
    stats: { provider: "codex", scannedFiles: files.length, skipped, distinctSessions: sessions.size, records: records.length },
  };
}
