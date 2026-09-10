import { NextRequest, NextResponse } from "next/server";
import { runProviderSync } from "../../../../lib/sync";

export const dynamic = "force-dynamic";

// On-demand + scheduler account sync (no PC job needed).
// Auth: Authorization: Bearer $CRON_SECRET.
// Pulls provider billing APIs (OpenCode service key) into the same tables
// the collector writes, under deviceId "cloud:<provider>".
export async function GET(req: NextRequest) {
  const h = req.headers.get("authorization") ?? "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  const token = (m?.[1] ?? "").trim();
  if (!process.env.CRON_SECRET || token !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const results = await runProviderSync();
  const ok = results.every((r) => r.ok || r.skipped);
  return NextResponse.json({ ok, sync: results });
}
