import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface FileCacheEntry {
  size: number;
  mtime: number;
  offset: number;
}

export interface DashState {
  lastPushDay: string | null;
  fileCache: Record<string, FileCacheEntry>;
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
    if (!parsed.fileCache) parsed.fileCache = {};
    return { state: parsed, path: p };
  } catch {
    return { state: { lastPushDay: null, fileCache: {} }, path: p };
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
