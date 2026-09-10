import * as fs from "node:fs";
import * as path from "node:path";

// Minimal .env loader (no new dependencies).
// Loads ./.env (server dir when started from there) without overriding
// already-exported variables, so real env always wins.
export function loadEnv(): void {
  const candidates = [
    path.join(process.cwd(), ".env"),
    path.join(path.dirname(new URL(import.meta.url).pathname), ".env"),
  ];
  for (const f of candidates) {
    let raw: string;
    try {
      raw = fs.readFileSync(f, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#") || !t.includes("=")) continue;
      const i = t.indexOf("=");
      const k = t.slice(0, i).trim();
      let v = t.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (k && !(k in process.env)) process.env[k] = v;
    }
    break; // first file found wins
  }
}
