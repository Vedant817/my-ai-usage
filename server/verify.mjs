// Server verification: ingest -> summary -> last-day -> stale behavior. No secrets printed.
import { createApp } from "./routes.js";

process.env.INGEST_TOKEN = "test-ingest";
process.env.READ_TOKEN = "test-read";
process.env.DATABASE_URL = ":memory:";
process.env.SITE_ORIGIN = "http://localhost:3000";

const app = createApp();
let pass = 0, fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; console.log(`ok: ${name}`); }
  else { fail++; console.log(`FAIL: ${name}`); }
};

const ingest = {
  deviceId: "pc1", deviceLabel: "PC",
  pushedAt: new Date().toISOString(),
  days: [
    {
      day: "2026-09-04",
      byProvider: {
        codex: { uncached: 100, cached: 200, cacheCreation: 0, output: 300, reasoning: 10, totalTokens: 600, costUsd: 1.5, sessions: 2, records: 5 },
        claude: { uncached: 0, cached: 0, cacheCreation: 0, output: 0, reasoning: 0, totalTokens: 0, costUsd: 0, sessions: 0, records: 0 },
        grok: { uncached: 0, cached: 0, cacheCreation: 0, output: 0, reasoning: 0, totalTokens: 0, costUsd: 0, sessions: 0, records: 0 },
        opencode: { uncached: 50, cached: 0, cacheCreation: 0, output: 50, reasoning: 0, totalTokens: 100, costUsd: 0.5, sessions: 1, records: 2 },
        antigravity: { uncached: 6000, cached: 1000, cacheCreation: 0, output: 2000, reasoning: 0, totalTokens: 9000, costUsd: 0.4, sessions: 1, records: 1 },
      },
      models: [
        { provider: "codex", model: "gpt-5", totalTokens: 600, costUsd: 1.5 },
        { provider: "antigravity", model: "gemini-2.5-flash", totalTokens: 9000, costUsd: 0.4, estimated: true },
      ],
    },
  ],
};

// 1. unauthorized ingest rejected
let r = await app.request("/v1/ingest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(ingest) });
check("ingest 401 without token", r.status === 401);

// 2. authorized ingest
r = await app.request("/v1/ingest", { method: "POST", headers: { "content-type": "application/json", Authorization: "Bearer test-ingest" }, body: JSON.stringify(ingest) });
const ib = await r.json();
check("ingest ok", r.status === 200 && ib.ok === true);

// 3. summary exact day
r = await app.request("/v1/summary?day=2026-09-04", { headers: { Authorization: "Bearer test-read" } });
const s = await r.json();
check("summary day", s.day === "2026-09-04" && s.requestedDay === "2026-09-04");
check("summary totals", s.totalTokens === 9700 && Math.abs(s.costUsd - 2.4) < 1e-9 && s.sessions === 4);
check("summary providers", s.byProvider?.codex?.costUsd === 1.5 && s.byProvider?.antigravity?.totalTokens === 9000);
check("summary models estimated", s.models?.some((m) => m.estimated === true));
check("summary daily", Array.isArray(s.daily) && s.daily.length === 1);

// 4. missing day falls back to latest + stale
r = await app.request("/v1/summary?day=2026-09-05", { headers: { Authorization: "Bearer test-read" } });
const s2 = await r.json();
check("fallback latest + stale", s2.day === "2026-09-04" && s2.isStale === true);

// 5. last-day
r = await app.request("/v1/last-day", { headers: { Authorization: "Bearer test-read" } });
const l = await r.json();
check("last-day", l.lastDay === "2026-09-04");

// 6. upsert same day replaces (no double count)
const ingest2 = JSON.parse(JSON.stringify(ingest));
ingest2.days[0].byProvider.codex.costUsd = 9;
ingest2.days[0].byProvider.codex.totalTokens = 999;
await app.request("/v1/ingest", { method: "POST", headers: { "content-type": "application/json", Authorization: "Bearer test-ingest" }, body: JSON.stringify(ingest2) });
r = await app.request("/v1/summary?day=2026-09-04", { headers: { Authorization: "Bearer test-read" } });
const s3 = await r.json();
check("upsert replaces", s3.byProvider.codex.costUsd === 9 && s3.totalTokens === 999 + 100 + 9000);

// 7. health + read auth
r = await app.request("/health");
check("health", r.status === 200 && (await r.json()).ok === true);
r = await app.request("/v1/summary?day=2026-09-04");
check("summary 401 without token", r.status === 401);

// 8. no PII in stored rows (only numeric buckets + model names)
const { db } = await import("./db.js");
const rows = db().prepare("SELECT by_provider, models FROM pushes").all();
const blob = JSON.stringify(rows);
check("no absolute paths in DB", !blob.includes("C:\\\\") && !blob.includes("/home/") && !blob.match(/[A-Z]:\//));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
