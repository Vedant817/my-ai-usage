import { NextRequest, NextResponse } from "next/server";
import { init, upsertDay } from "../../../../lib/store";

export const dynamic = "force-dynamic";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function bearer(req: NextRequest): string {
  const h = req.headers.get("authorization") ?? "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return (m?.[1] ?? "").trim();
}

export async function POST(req: NextRequest) {
  if (bearer(req) !== (process.env.INGEST_TOKEN ?? "")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const deviceId = String(body?.deviceId ?? "").slice(0, 120);
  const pushedAt = String(body?.pushedAt ?? new Date().toISOString());
  const days = body?.days;
  if (!deviceId || !process.env.INGEST_TOKEN || !Array.isArray(days) || days.length > 400) {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  await init();
  let n = 0;
  for (const d of days) {
    if (!d || !DAY_RE.test(String(d.day))) continue;
    if (typeof d.byProvider !== "object" || d.byProvider == null) continue;
    await upsertDay(deviceId, String(d.day), d.byProvider, d.models ?? [], pushedAt);
    n++;
  }
  return NextResponse.json({ ok: true, days: n });
}
