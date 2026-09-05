import { Hono } from "hono";
import { cors } from "hono/cors";
import { aggregateDay, dailySeries, getMeta, lastDay, latestDayAtOrBefore, upsertDay } from "./db.js";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function bearer(c: { req: { header: (h: string) => string | undefined } }): string {
  const h = c.req.header("authorization") ?? "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return (m?.[1] ?? "").trim();
}

export function createApp(): Hono {
  const app = new Hono();

  const origins = (process.env.SITE_ORIGIN ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  app.use("*", cors({
    origin: origins.length ? origins : ["http://localhost:3000"],
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Authorization", "Content-Type"],
    maxAge: 86400,
  }));

  app.get("/health", (c) => c.json({ ok: true }));

  app.get("/v1/last-day", (c) => {
    const token = bearer(c);
    if (token !== process.env.READ_TOKEN && token !== process.env.INGEST_TOKEN) {
      return c.json({ error: "unauthorized" }, 401);
    }
    return c.json({ lastDay: lastDay() });
  });

  app.post("/v1/ingest", async (c) => {
    if (bearer(c) !== process.env.INGEST_TOKEN) return c.json({ error: "unauthorized" }, 401);
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    const deviceId = String(body?.deviceId ?? "").slice(0, 120);
    const deviceLabel = String(body?.deviceLabel ?? "").slice(0, 120);
    const pushedAt = String(body?.pushedAt ?? new Date().toISOString());
    const days = body?.days;
    if (!deviceId || !Array.isArray(days) || days.length > 400) {
      return c.json({ error: "invalid body" }, 400);
    }
    void deviceLabel;
    let n = 0;
    for (const d of days) {
      if (!d || !DAY_RE.test(String(d.day))) continue;
      if (typeof d.byProvider !== "object" || d.byProvider == null) continue;
      upsertDay(deviceId, String(d.day), d.byProvider, d.models ?? [], pushedAt);
      n++;
    }
    return c.json({ ok: true, days: n });
  });

  app.get("/v1/summary", (c) => {
    if (bearer(c) !== process.env.READ_TOKEN && bearer(c) !== process.env.INGEST_TOKEN) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const q = c.req.query("day");
    const today = new Date().toLocaleDateString("en-CA");
    const requestedDay = DAY_RE.test(q ?? "") ? (q as string) : today;
    const resolved = latestDayAtOrBefore(requestedDay);
    if (!resolved) {
      return c.json({
        requestedDay, day: requestedDay, isStale: true,
        lastPushAt: getMeta("lastPushAt") ?? null, readAt: new Date().toISOString(),
        totalTokens: 0, costUsd: 0, sessions: 0,
        byProvider: {}, models: [], daily: [],
      });
    }
    const agg = aggregateDay(resolved);
    let totalTokens = 0, costUsd = 0, sessions = 0;
    for (const b of Object.values(agg.byProvider)) {
      totalTokens += b.totalTokens; costUsd += b.costUsd; sessions += b.sessions;
    }
    const lastPushAt = getMeta("lastPushAt") ?? `${resolved}T23:59:59.000Z`;
    const stale = Date.now() - Date.parse(lastPushAt) > 30 * 60 * 1000 || resolved !== requestedDay;
    return c.json({
      requestedDay, day: resolved, isStale: stale,
      lastPushAt, readAt: new Date().toISOString(),
      totalTokens, costUsd: Math.round(costUsd * 10000) / 10000, sessions,
      byProvider: agg.byProvider, models: agg.models,
      daily: dailySeries(30, resolved),
    });
  });

  return app;
}
