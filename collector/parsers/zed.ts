import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { openReadonly } from "../sqlite.js";
import { dayOfLocal, type ParserResult, type UsageRecord } from "../types.js";
import type { DashState } from "../state.js";

// Zed AI usage from the local agent thread store.
// Format discovery: threads.db -> threads(data_type, data); zstd payloads are
// JSON with {model:{provider,name}, request_token_usage:[{token_usage:{...}}],
// cumulative_token_usage, created_at, updated_at}. Only threads routed through
// Zed-hosted models (provider "zed.dev") are billable and counted; threads via
// own API keys / Copilot / local models are skipped (no Zed billing impact).
// (Field layout cross-checked against the openusage project's zed provider.)
//
// Approximation: usage is cumulative per thread, so a whole thread is
// attributed to a single day (created_at, stable across runs -> stable history).

const MAX_DECOMPRESSED = 32 << 20;
const MAX_ROWS = 2000;

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function dbCandidates(): string[] {
  const override = (process.env.ZED_THREADS_DB ?? "").trim();
  if (override) return [override];
  const home = os.homedir();
  const out: string[] = [];
  if (process.platform === "win32") {
    const lad = (process.env.LOCALAPPDATA ?? "").trim();
    if (lad) out.push(path.join(lad, "Zed", "threads", "threads.db"));
    out.push(path.join(home, "AppData", "Local", "Zed", "threads", "threads.db"));
  } else if (process.platform === "darwin") {
    out.push(path.join(home, "Library", "Application Support", "Zed", "threads", "threads.db"));
  } else {
    const xdg = (process.env.XDG_DATA_HOME ?? "").trim();
    if (xdg) out.push(path.join(xdg, "zed", "threads", "threads.db"));
    out.push(path.join(home, ".local", "share", "zed", "threads", "threads.db"));
  }
  return out;
}

function toMs(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v === "string" && v) {
    const m = Date.parse(v);
    return Number.isFinite(m) ? m : null;
  }
  return null;
}

function decodeData(data: unknown, dataType: unknown): string | null {
  const buf = typeof data === "string"
    ? Buffer.from(data, "utf8")
    : Buffer.isBuffer(data) ? data
    : data instanceof Uint8Array ? Buffer.from(data)
    : null;
  if (!buf || buf.length === 0) return null;
  const t = String(dataType ?? "").toLowerCase().trim();
  try {
    if (t === "" || t === "json") return buf.toString("utf8");
    if (t === "zstd") {
      const out = (zlib as any).zstdDecompressSync(buf, { maxOutputLength: MAX_DECOMPRESSED });
      return Buffer.from(out).toString("utf8");
    }
  } catch { /* corrupt row -> skip */ }
  return null;
}

export async function parseZed(
  state: DashState,
  windowStartMs: number,
  dayFilter: (day: string) => boolean,
): Promise<ParserResult> {
  void state;
  const records: UsageRecord[] = [];
  const sessions = new Set<string>();
  let scannedFiles = 0;
  let skipped = 0;
  let nonHosted = 0;
  const slack = windowStartMs - 36 * 3600 * 1000;

  let dbPath: string | null = null;
  for (const c of dbCandidates()) {
    try {
      if (fs.statSync(c).isFile()) { dbPath = c; break; }
    } catch { /* try next */ }
  }
  const done = (note?: string): ParserResult => ({
    records,
    stats: {
      provider: "zed", scannedFiles, skipped,
      distinctSessions: sessions.size, records: records.length, note,
    },
  });
  if (!dbPath) return done("no Zed thread store found");

  let st: fs.Stats;
  try {
    st = fs.statSync(dbPath);
  } catch {
    return done("thread store unreadable");
  }
  if (st.mtimeMs < slack) return done("thread store older than window");
  scannedFiles++;

  try {
    const db = await openReadonly(dbPath);
    try {
      const tables = db.rows(`SELECT name FROM sqlite_master WHERE type='table'`) as Array<{ name: string }>;
      if (!tables.some((t) => t.name === "threads")) return done("no threads table");
      const cols = db.rows(`PRAGMA table_info(threads)`) as Array<{ name: string }>;
      const has = new Set(cols.map((c) => String(c.name)));
      const sel = ["id",
        has.has("created_at") ? "created_at" : "NULL AS created_at",
        has.has("updated_at") ? "updated_at" : "NULL AS updated_at",
        has.has("data_type") ? "data_type" : "NULL AS data_type",
        "data",
      ].join(", ");
      const rows = db.rows(`SELECT ${sel} FROM threads LIMIT ${MAX_ROWS}`) as Array<Record<string, any>>;
      for (const row of rows) {
        try {
          // Cheap pre-filter on row timestamps before paying for decompression.
          const rowTs = toMs(row.created_at) ?? toMs(row.updated_at);
          if (rowTs != null && rowTs < slack && (toMs(row.updated_at) ?? rowTs) < slack) {
            skipped++;
            continue;
          }
          const text = decodeData(row.data, row.data_type);
          if (!text) { skipped++; continue; }
          let payload: any;
          try { payload = JSON.parse(text); } catch { skipped++; continue; }
          const modelObj = payload?.model ?? {};
          const provider = String(modelObj.provider ?? "").trim().toLowerCase();
          if (provider !== "zed.dev") { nonHosted++; continue; } // own keys/Copilot/local: not Zed-billed
          const model = String(modelObj.name ?? modelObj.model ?? modelObj.id ?? "unknown").trim() || "unknown";
          let input = 0, output = 0, cached = 0, created = 0, reasoning = 0;
          const perReq = payload?.request_token_usage;
          if (Array.isArray(perReq) && perReq.length > 0) {
            for (const e of perReq) {
              const u = e?.token_usage ?? {};
              input += num(u.input_tokens);
              output += num(u.output_tokens);
              cached += num(u.cache_read_input_tokens);
              created += num(u.cache_creation_input_tokens ?? u.cache_creation_tokens);
              reasoning += num(u.reasoning_tokens);
            }
          } else if (payload?.cumulative_token_usage && typeof payload.cumulative_token_usage === "object") {
            const u = payload.cumulative_token_usage;
            input = num(u.input_tokens);
            output = num(u.output_tokens);
            cached = num(u.cache_read_input_tokens);
            created += num(u.cache_creation_input_tokens ?? u.cache_creation_tokens);
            reasoning = num(u.reasoning_tokens);
          }
          if (!input && !output && !cached && !created) { skipped++; continue; }
          const ts = toMs(payload.created_at) ?? toMs(payload.updated_at) ?? rowTs ?? st.mtimeMs;
          if (ts < slack) { skipped++; continue; }
          const day = dayOfLocal(ts);
          if (!dayFilter(day)) continue;
          const id = String(row.id ?? "unknown");
          sessions.add(id);
          records.push({
            day, provider: "zed", model,
            uncached: Math.max(0, input - cached - created),
            cached, cacheCreation: created, output,
            reasoning: Math.min(reasoning, output),
            reportedCost: null, // priced via table (+10% Zed host markup in aggregate)
            sessionId: id, dedupeKey: `zed:${id}:${model}`,
          });
        } catch { skipped++; }
      }
    } finally {
      db.close();
    }
  } catch {
    return done("thread store query failed (non-fatal)");
  }

  const note = records.length
    ? undefined
    : nonHosted > 0
      ? `no zed.dev-hosted usage (${nonHosted} non-hosted thread(s) skipped)`
      : "no billable Zed threads in window";
  return done(note);
}
