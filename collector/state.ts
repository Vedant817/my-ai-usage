import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface FileCacheEntry {
  size: number;
  mtime: number;
  offset: number;
}

export interface DashState {
  v: 3;
  lastPushDay: string | null;
  /** Earliest day included when the current file caches were built. */
  cacheSinceDay?: string;
  fileCache: Record<string, FileCacheEntry>;
  /** Per-file raw records already read. Lets incremental scans skip I/O while
   *  still pushing FULL-day totals (server upserts replace the whole day). */
  fileRecords: Record<string, import("./types.js").UsageRecord[]>;
}

function statePath(dataDirOverride?: string): string {
  if (dataDirOverride) return path.join(dataDirOverride, "state.json");
  const base = process.env.USAGE_DASH_STATE_DIR
    || path.join(os.homedir(), ".usage-dash");
  return path.join(base, "state.json");
}

export function loadState(dataDirOverride?: string): { state: DashState; path: string } {
  const p = statePath(dataDirOverride);
  try {
    const raw = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(raw) as DashState;
    if ((parsed as DashState).v !== 3) {
      // Schema changed (window-independent record cache): re-baseline, keep lastPushDay.
      return { state: { v: 3, lastPushDay: (parsed as DashState).lastPushDay ?? null, fileCache: {}, fileRecords: {} }, path: p };
    }
    if (!parsed.fileCache) parsed.fileCache = {};
    if (!parsed.fileRecords) parsed.fileRecords = {};
    return { state: parsed, path: p };
  } catch {
    return { state: { v: 3, lastPushDay: null, fileCache: {}, fileRecords: {} }, path: p };
  }
}

export function saveState(p: string, state: DashState): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, p);
}

/** Decide how many bytes of `file` are new since last run. Returns {start, fresh}. */
export function incrementalRange(
  state: DashState,
  file: string,
  size: number,
  mtime: number,
): { start: number; fresh: boolean } {
  const prev = state.fileCache[file];
  if (!prev) return { start: 0, fresh: false };
  if (prev.size === size && prev.mtime === mtime) {
    return { start: size, fresh: true }; // unchanged -> skip
  }
  if (size >= prev.size && typeof prev.offset === "number" && prev.offset <= size) {
    return { start: prev.offset, fresh: false }; // grown -> resume
  }
  return { start: 0, fresh: false }; // shrunk/rotated -> reread
}

export function markRead(state: DashState, file: string, size: number, mtime: number, offset: number): void {
  state.fileCache[file] = { size, mtime, offset };
}

const MAX_PER_FILE = 20_000;

/**
 * Merge newly-read records into the per-file cache and return the file's full
 * contribution (cached + new). No day eviction: the cache is a superset and
 * each run filters by its own window, so varying --days stays correct.
 * Dedupe by provider+dedupeKey so re-reads (rotation/shrink) stay idempotent.
 */
export function mergeFileRecords(
  state: DashState,
  key: string,
  fresh: UsageRecordLite[],
): import("./types.js").UsageRecord[] {
  if (!state.fileRecords) state.fileRecords = {};
  const prev = state.fileRecords[key] ?? [];
  const byKey = new Map<string, import("./types.js").UsageRecord>();
  for (const r of prev) byKey.set(`${r.provider}:${r.dedupeKey}`, r);
  for (const r of fresh as import("./types.js").UsageRecord[]) {
    byKey.set(`${r.provider}:${r.dedupeKey}`, r);
  }
  let all = [...byKey.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
  if (all.length > MAX_PER_FILE) all = all.slice(all.length - MAX_PER_FILE);
  state.fileRecords[key] = all;
  return all;
}

/** Drop cache entries for files that no longer exist (bounded growth).
 *  Only touches keys with the given prefix so parsers can't wipe each other. */
export function pruneFileRecords(state: DashState, liveKeys: Set<string>, prefix: string): void {
  if (!state.fileRecords) return;
  for (const k of Object.keys(state.fileRecords)) {
    if (k.startsWith(prefix) && !liveKeys.has(k)) delete state.fileRecords[k];
  }
}

// Local structural type to avoid a hard import cycle at runtime (types-only).
interface UsageRecordLite {
  day: string;
  provider: string;
  dedupeKey: string;
}

/** Recursively list files matching predicate, filtered by mtime. Never throws. */
export function walkFiles(
  roots: string[],
  opts: { extensions?: string[]; fileName?: string; minMtimeMs: number },
): string[] {
  const out: string[] = [];
  const exts = opts.extensions?.map((e) => e.toLowerCase());
  for (const root of roots) {
    try {
      const st = fs.statSync(root);
      if (st.isFile()) {
        if (st.mtimeMs >= opts.minMtimeMs) out.push(root);
        continue;
      }
      if (!st.isDirectory()) continue;
    } catch {
      continue;
    }
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        try {
          if (e.isDirectory()) {
            stack.push(full);
          } else if (e.isFile()) {
            if (opts.fileName && e.name !== opts.fileName) continue;
            if (exts && !exts.some((x) => e.name.toLowerCase().endsWith(x))) continue;
            const s = fs.statSync(full);
            if (s.mtimeMs >= opts.minMtimeMs) out.push(full);
          }
        } catch {
          continue;
        }
      }
    }
  }
  return out;
}
