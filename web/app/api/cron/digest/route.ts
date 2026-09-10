import { NextRequest, NextResponse } from "next/server";
import { init } from "../../../../lib/store";
import { runDigestOnce } from "../../../../lib/digest";
import { runProviderSync } from "../../../../lib/sync";

export const dynamic = "force-dynamic";

// Vercel Cron (vercel.json) + any external scheduler.
// Auth: Authorization: Bearer $CRON_SECRET (Vercel sends this automatically).
export async function GET(req: NextRequest) {
  const h = req.headers.get("authorization") ?? "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  const token = (m?.[1] ?? "").trim();
  if (!process.env.CRON_SECRET || token !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  await init();
  // Refresh account-level usage first so the digest reflects cloud data.
  // Best-effort: sync failures never block the digest.
  let sync: Awaited<ReturnType<typeof runProviderSync>> = [];
  try {
    sync = await runProviderSync();
  } catch { /* digest proceeds regardless */ }
  const result = await runDigestOnce("scheduled");
  return NextResponse.json({ ok: true, sync, ...result });
}
