import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openReadonly } from "../sqlite.js";
import { dayOfLocal, type ParserResult, type UsageRecord } from "../types.js";
import { walkFiles } from "../state.js";
import type { DashState } from "../state.js";

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function dataRoot(): string {
  return process.env.OPENCODE_DATA_DIR
    ?? (process.env.XDG_DATA_HOME ? path.join(process.env.XDG_DATA_HOME, "opencode") : path.join(os.homedir(), ".local", "share", "opencode"));
}

function toMs(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v === "string") {
    const m = Date.parse(v);
    if (Number.isFinite(m)) return m;
  }
  return fallback;
}

// Turns run in OpenCode can be backed by different accounts: Zen ("opencode"),
// a Codex/ChatGPT subscription or API key ("openai"), etc. Keep every turn in
// the opencode provider bucket (counted exactly once — these turns never appear
// in ~/.codex/sessions), but label non-Zen rows with their backing provider so
// subscription-backed usage is distinguishable in the model table.
function modelLabel(model: unknown, providerID: unknown): string {
  const m = String(model ?? "unknown");
  const pid = String(providerID ?? "").trim().toLowerCase();
  if (pid && pid !== "opencode" && !m.includes("/")) return `${pid}/${m}`;
  return m;
}

export async function parseOpencode(
  state: DashState,
  windowStartMs: number,
  dayFilter: (day: string) => boolean,
): Promise<ParserResult> {
  void state;
  const records: UsageRecord[] = [];
  const sessions = new Set<string>();
  let scannedFiles = 0;
  let skipped = 0;
  const slack = windowStartMs - 36 * 3600 * 1000;

  const root = dataRoot();
  const dbPath = path.join(root, "opencode.db");

  const pushRow = (
    model: string, tokens: any, cost: unknown, timeMs: number,
    id: string, sessionId: string,
  ) => {
    if (timeMs < slack) return;
    const day = dayOfLocal(timeMs);
    if (!dayFilter(day)) return;
    const input = num(tokens?.input);
    const output = num(tokens?.output);
    const cached = num(tokens?.cache?.read ?? tokens?.cached);
    const created = num(tokens?.cache?.write ?? tokens?.cacheWrite ?? tokens?.cache_creation);
    const reasoning = num(tokens?.reasoning);
    if (!input && !output && !cached && !created) return;
    const c = Number(cost);
    sessions.add(sessionId);
    records.push({
      day, provider: "opencode",
      model: model || "unknown",
      uncached: Math.max(0, input - cached - created),
      cached, cacheCreation: created, output,
      reasoning: Math.min(reasoning, output),
      reportedCost: Number.isFinite(c) && c >= 0 && c > 0 ? c : null,
      sessionId, dedupeKey: id || `${sessionId}:${timeMs}:${model}`,
    });
  };

  let dbHit = false;
  try {
    const st = fs.statSync(dbPath);
    if (st.mtimeMs >= slack) {
      scannedFiles++;
      const db = await openReadonly(dbPath);
      try {
        const rows = db.rows(
          `SELECT id, session_id AS sessionId, time_created AS timeCreated, data
           FROM message WHERE json_extract(data,'$.role')='assistant' AND time_created >= ?`,
          Math.floor(slack),
        ) as Array<{ id: string; sessionId: string; timeCreated: number; data: string }>;
        for (const r of rows) {
          try {
            const d = JSON.parse(r.data as unknown as string);
            const tokens = d.tokens ?? d.tokenUsage ?? {};
            const model = modelLabel(d.modelID ?? d.model, d.providerID ?? d.provider);
            const t = d.time?.completed ?? d.time?.created ?? r.timeCreated;
            pushRow(model, tokens, d.cost, toMs(t, Number(r.timeCreated)), String(r.id), String(r.sessionId));
          } catch { /* bad row */ }
        }
        dbHit = true;
      } finally {
        db.close();
      }
    }
  } catch {
    // fall through to JSON fallback
  }

  if (!dbHit) {
    const storageRoots = [
      path.join(root, "storage", "message"),
      path.join(root, "storage"),
      path.join(root, "message"),
    ];
    const files = walkFiles(storageRoots, { extensions: [".json"], minMtimeMs: slack });
    // Also match storage/message/*/*.json layout explicitly
    scannedFiles += files.length;
    for (const f of files) {
      try {
        const raw = fs.readFileSync(f, "utf8");
        const d = JSON.parse(raw);
        const role = d.role ?? d.data?.role;
        if (role && role !== "assistant") continue;
        const tokens = d.tokens ?? d.data?.tokens ?? {};
        const model = modelLabel(d.modelID ?? d.model ?? d.data?.modelID, d.data?.providerID);
        const t = d.time?.completed ?? d.time?.created ?? d.timeCreated ?? fs.statSync(f).mtimeMs;
        pushRow(model, tokens, d.cost ?? d.data?.cost, toMs(t, Date.now()),
          String(d.id ?? d.info?.id ?? f), String(d.sessionID ?? d.session_id ?? path.basename(path.dirname(f))));
      } catch {
        skipped++;
      }
    }
    if (files.length === 0) {
      // No db and no JSON fallback: check project-local storage dirs
      try {
        const cwdStorage = path.join(process.cwd(), ".opencode", "storage", "message");
        const extra = walkFiles([cwdStorage], { extensions: [".json"], minMtimeMs: 0 });
        scannedFiles += extra.length;
      } catch { /* ignore */ }
      if (records.length === 0) skipped++;
    }
  }

  return {
    records,
    stats: {
      provider: "opencode", scannedFiles, skipped,
      distinctSessions: sessions.size, records: records.length,
      note: dbHit ? undefined : "db unavailable, used JSON fallback",
    },
  };
}
