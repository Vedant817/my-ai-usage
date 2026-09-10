import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openReadonly } from "../sqlite.js";
import { dayOfLocal, type ParserResult, type UsageRecord } from "../types.js";
import type { DashState } from "../state.js";

const AVG_INPUT = Number(process.env.ANTI_AVG_INPUT ?? 6000);
const AVG_OUTPUT = Number(process.env.ANTI_AVG_OUTPUT ?? 2000);
const AVG_CACHED = Number(process.env.ANTI_AVG_CACHED ?? 1000);

function listDbs(): string[] {
  const home = os.homedir();
  const dirs = [
    process.env.ANTIGRAVITY_DIR,
    path.join(home, ".gemini", "antigravity-cli", "conversations"),
    path.join(home, ".gemini", "antigravity", "conversations"),
  ].filter(Boolean) as string[];
  const out: string[] = [];
  for (const d of dirs) {
    try {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isFile() && e.name.endsWith(".db")) out.push(path.join(d, e.name));
      }
    } catch { /* missing dir -> skip, never fail */ }
  }
  return out;
}

function extractModelsFromBlob(blob: Buffer | Uint8Array | string): string[] {
  // gen_metadata BLOBs embed model names as text; scan for known families.
  // Family list is intentionally broad (not just gemini/claude/gpt/grok) so a
  // newly adopted model still attributes to its own name instead of collapsing
  // into the gemini-2.5-flash fallback. Unknown shapes stay estimated anyway.
  let text: string;
  if (typeof blob === "string") text = blob;
  else text = Buffer.from(blob as Uint8Array).toString("utf8");
  const found = new Set<string>();
  const re = /(gemini-[\w.\-]+|claude-[\w.\-]+|gpt-[\w.\-]+|grok-[\w.\-]+|deepseek-[\w.\-]+|kimi-[\w.\-]+|qwen-[\w.\-]+|glm-[\w.\-]+|minimax-[\w.\-]+|mistral-[\w.\-]+|mixtral-[\w.\-]+|llama-[\w.\-]+|Muse-[\w.\-]+|codestral-[\w.\-]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) != null) {
    found.add(m[1].toLowerCase());
  }
  return [...found];
}

export async function parseAntigravity(
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

  try {
    const dbs = listDbs();
    for (const dbPath of dbs) {
      try {
        const st = fs.statSync(dbPath);
        if (st.mtimeMs < slack) { skipped++; continue; }
        scannedFiles++;
        const db = await openReadonly(dbPath);
        try {
          // Schema varies by version; probe tables defensively.
          // Observed (2026): trajectory_meta / steps / gen_metadata / executor_metadata.
          // Legacy: conversations / conversation with updated_at.
          const tables = db.rows(
            `SELECT name FROM sqlite_master WHERE type='table'`,
          ) as Array<{ name: string }>;
          const names = new Set(tables.map((t) => t.name));
          const convId = path.basename(dbPath, ".db");
          const day = dayOfLocal(st.mtimeMs);
          if (!dayFilter(day)) { skipped++; continue; }
          sessions.add(convId);

          if (names.has("gen_metadata")) {
            // One gen_metadata row ≈ one turn. No per-turn timestamps stored,
            // so attribute to file-mtime day (documented estimate).
            let rows: Array<Record<string, any>> = [];
            try {
              rows = db.rows(`SELECT idx, data FROM gen_metadata LIMIT 20000`) as Array<Record<string, any>>;
            } catch { rows = []; }
            for (const row of rows) {
              try {
                const v: unknown = (row as any).data;
                const buf = typeof v === "string" ? v : Buffer.isBuffer(v) ? v : v instanceof Uint8Array ? Buffer.from(v) : null;
                let models = buf ? extractModelsFromBlob(buf) : [];
                models = [...new Set(models)];
                if (models.length === 0) models = ["gemini-2.5-flash"];
                for (const model of models.slice(0, 2)) {
                  records.push({
                    day, provider: "antigravity", model,
                    uncached: AVG_INPUT, cached: AVG_CACHED, cacheCreation: 0,
                    output: AVG_OUTPUT, reasoning: 0,
                    reportedCost: null, sessionId: convId,
                    dedupeKey: `${convId}:${String((row as any).idx ?? records.length)}:${model}`,
                    estimated: true,
                  });
                }
              } catch { skipped++; }
            }
            // Sibling JSONL sidecar (if present) can carry extra model hints; fold in as turns too.
            try {
              const sidecar = dbPath.replace(/\.db$/, ".jsonl");
              const sst = fs.statSync(sidecar);
              if (sst.mtimeMs >= slack) {
                const text = fs.readFileSync(sidecar, "utf8").slice(0, 200_000);
                const models = [...new Set(extractModelsFromBlob(text))];
                for (const model of models.slice(0, 3)) {
                  records.push({
                    day, provider: "antigravity", model,
                    uncached: AVG_INPUT, cached: AVG_CACHED, cacheCreation: 0,
                    output: AVG_OUTPUT, reasoning: 0,
                    reportedCost: null, sessionId: convId,
                    dedupeKey: `${convId}:sidecar:${model}`,
                    estimated: true,
                  });
                }
              }
            } catch { /* no sidecar */ }
            continue;
          }

          const convTable = names.has("conversations") ? "conversations"
            : names.has("conversation") ? "conversation" : null;
          if (!convTable) { skipped++; continue; }
          const cols = db.rows(`PRAGMA table_info(${convTable})`) as Array<{ name: string }>;
          const colNames = new Set(cols.map((c) => c.name));
          const hasUpdated = colNames.has("updated_at");
          const idCol = colNames.has("id") ? "id" : "rowid";
          const rows = db.rows(
            hasUpdated
              ? `SELECT * FROM ${convTable} WHERE updated_at >= ? LIMIT 5000`
              : `SELECT * FROM ${convTable} LIMIT 5000`,
            ...(hasUpdated ? [Math.floor(slack / 1000), Math.floor(slack)] : []),
          ) as Array<Record<string, any>>;
          // updated_at may be seconds or ms; accept either by also filtering in JS.
          for (const row of rows) {
            try {
              const id = String(row[idCol] ?? row.conversation_id ?? dbPath);
              const tsRaw = row.updated_at ?? row.updatedAt ?? row.created_at ?? st.mtimeMs;
              let tsMs = Number(tsRaw);
              if (!Number.isFinite(tsMs)) tsMs = st.mtimeMs;
              else if (tsMs < 1e12) tsMs = tsMs * 1000;
              if (tsMs < slack) continue;
              const rday = dayOfLocal(tsMs);
              if (!dayFilter(rday)) continue;
              // Collect candidate blobs/texts
              const blobs: Array<Buffer | string> = [];
              for (const [k, v] of Object.entries(row)) {
                if (/gen_metadata|metadata|model|turn/i.test(k) && v != null) {
                  if (typeof v === "string" || Buffer.isBuffer(v) || v instanceof Uint8Array) blobs.push(v as any);
                  else if (typeof v === "object") blobs.push(JSON.stringify(v));
                }
              }
              // Sibling JSONL sidecar
              const sidecar = dbPath.replace(/\.db$/, ".jsonl");
              try {
                const sst = fs.statSync(sidecar);
                if (sst.mtimeMs >= slack) {
                  blobs.push(fs.readFileSync(sidecar, "utf8").slice(0, 200_000));
                }
              } catch { /* no sidecar */ }
              let models: string[] = [];
              for (const b of blobs) models.push(...extractModelsFromBlob(b as Buffer));
              models = [...new Set(models)];
              if (models.length === 0) models = ["gemini-2.5-flash"];
              // One turn per model per conversation per day (estimate). Count rows as turns.
              // If the row embeds multiple turns we still count 1 to stay conservative.
              for (const model of models) {
                const key = `${id}:${rday}:${model}`;
                sessions.add(id);
                records.push({
                  day: rday, provider: "antigravity", model,
                  uncached: AVG_INPUT, cached: AVG_CACHED, cacheCreation: 0,
                  output: AVG_OUTPUT, reasoning: 0,
                  reportedCost: null, sessionId: id, dedupeKey: key,
                  estimated: true,
                });
              }
            } catch { skipped++; }
          }
        } finally {
          db.close();
        }
      } catch {
        skipped++;
      }
    }
  } catch {
    // Never fail whole run if antigravity fails.
    return {
      records: [],
      stats: { provider: "antigravity", scannedFiles, skipped: skipped + 1, distinctSessions: 0, records: 0, note: "antigravity scan failed (non-fatal)" },
    };
  }

  return {
    records,
    stats: {
      provider: "antigravity", scannedFiles, skipped,
      distinctSessions: sessions.size, records: records.length,
      note: records.length ? "estimated (no token counts stored)" : undefined,
    },
  };
}
