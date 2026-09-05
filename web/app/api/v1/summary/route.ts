import { NextRequest, NextResponse } from "next/server";
import { aggregateDay, dailySeries, getMeta, init, latestDayAtOrBefore } from "../../../../lib/store";

export const dynamic = "force-dynamic";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function authorized(req: NextRequest): boolean {
  const h = req.headers.get("authorization") ?? "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  const token = (m?.[1] ?? "").trim();
  return token !== "" && (token === process.env.READ_TOKEN || token === process.env.INGEST_TOKEN);
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const q = req.nextUrl.searchParams.get("day");
  const today = new Date().toLocaleDateString("en-CA");
  const requestedDay = q && DAY_RE.test(q) ? q : today;
  await init();
  const resolved = await latestDayAtOrBefore(requestedDay);
  if (!resolved) {
    return NextResponse.json({
      requestedDay, day: requestedDay, isStale: true,
      lastPushAt: (await getMeta("lastPushAt")) ?? null, readAt: new Date().toISOString(),
      totalTokens: 0, costUsd: 0, sessions: 0,
      byProvider: {}, models: [], daily: [],
    });
  }
  const agg = await aggregateDay(resolved);
  let totalTokens = 0, costUsd = 0, sessions = 0;
  for (const b of Object.values(agg.byProvider)) {
    totalTokens += b.totalTokens; costUsd += b.costUsd; sessions += b.sessions;
  }
  const lastPushAt = (await getMeta("lastPushAt")) ?? `${resolved}T23:59:59.000Z`;
  const stale = Date.now() - Date.parse(lastPushAt) > 30 * 60 * 1000 || resolved !== requestedDay;
  return NextResponse.json({
    requestedDay, day: resolved, isStale: stale,
    lastPushAt, readAt: new Date().toISOString(),
    totalTokens, costUsd: Math.round(costUsd * 10000) / 10000, sessions,
    byProvider: agg.byProvider, models: agg.models,
    daily: await dailySeries(30, resolved),
  });
}
