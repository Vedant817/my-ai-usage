// Driver-agnostic read-only SQLite helper.
// Tries node:sqlite (Node 22+) then bun:sqlite (Bun). Throws if neither loads;
// callers must catch and fall back (opencode JSON, antigravity skip) — never fatal.
export interface RoDb {
  rows(sql: string, ...params: any[]): Array<Record<string, any>>;
  close(): void;
}

export async function openReadonly(path: string, timeoutMs = 5000): Promise<RoDb> {
  try {
    const mod = await import("node:sqlite");
    const Db = (mod as any).DatabaseSync;
    const db = new Db(path, { readOnly: true, timeout: timeoutMs } as any);
    return {
      rows: (sql: string, ...params: any[]) => db.prepare(sql).all(...params) as Array<Record<string, any>>,
      close: () => db.close(),
    };
  } catch { /* try bun */ }
  try {
    const mod = await import("bun:sqlite");
    const Db = (mod as any).Database;
    const db = new Db(path, { readonly: true, timeout: timeoutMs } as any);
    return {
      rows: (sql: string, ...params: any[]) => db.query(sql).all(...params) as Array<Record<string, any>>,
      close: () => db.close(),
    };
  } catch (e) {
    throw new Error(`no sqlite driver: ${e instanceof Error ? e.message : String(e)}`);
  }
}
