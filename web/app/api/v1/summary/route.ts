import { NextRequest, NextResponse } from "next/server";
import { aggregateDay, dailySeries, emptyProviders, getMeta, init, latestDayAtOrBefore } from "../../../../lib/store";

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
  const daysRaw = Number(req.nextUrl.searchParams.get("days") ?? 30);
  const rangeDays = Number.isFinite(daysRaw) ? Math.min(90, Math.max(1, Math.floor(daysRaw))) : 30;
  await init();
  const opencodeAccount = Boolean(process.env.OPENCODE_SERVICE_KEY?.trim());
  const coverage = {
    codex: { mode: "device", note: "This device only; Codex subscriptions have no account usage API." },
    claude: { mode: "device", note: "This device only; Claude subscriptions have no account usage API." },
    grok: { mode: "device", note: "This device only; Grok subscriptions have no account usage API." },
    opencode: opencodeAccount
      ? { mode: "account", note: "Account export covers all devices for the last 30 days.", maxDays: 30, lastSyncAt: await getMeta("sync:opencode:lastAt") }
      : { mode: "device", note: "This device only. Configure OPENCODE_SERVICE_KEY for account-wide usage." },
    antigravity: { mode: "device", note: "This device only; Antigravity exposes no historical account usage API." },
  } as const;
  const resolved = await latestDayAtOrBefore(requestedDay);
  if (!resolved) {
    return NextResponse.json({
      requestedDay, day: requestedDay, isStale: true,
      lastPushAt: (await getMeta("lastPushAt")) ?? null, readAt: new Date().toISOString(),
      totalTokens: 0, costUsd: 0, sessions: 0,
      byProvider: emptyProviders(), models: [], rangeDays, daily: [], coverage,
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
    rangeDays, daily: await dailySeries(rangeDays, resolved), coverage,
  });
}
