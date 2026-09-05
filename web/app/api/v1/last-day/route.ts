import { NextRequest, NextResponse } from "next/server";
import { init, lastDay } from "../../../../lib/store";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const h = req.headers.get("authorization") ?? "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  const token = (m?.[1] ?? "").trim();
  if (token === "" || (token !== process.env.READ_TOKEN && token !== process.env.INGEST_TOKEN)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  await init();
  return NextResponse.json({ lastDay: await lastDay() });
}
