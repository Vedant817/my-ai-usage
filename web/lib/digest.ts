import { aggregateDay, getMeta, lastDay } from "./store";

const PROVIDER_LABEL: Record<string, string> = {
  codex: "Codex", claude: "Claude", grok: "Grok", opencode: "OpenCode", antigravity: "Antigravity",
};

function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

function fmtTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return `${Math.round(n)}`;
}

function ago(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export async function buildDigestText(day: string): Promise<{ text: string; total: number } | null> {
  const agg = await aggregateDay(day);
  let total = 0;
  for (const b of Object.values(agg.byProvider)) total += b.costUsd;
  if (!total && Object.values(agg.byProvider).every((b) => b.totalTokens === 0)) return null;
  const parts: string[] = [];
  for (const p of ["codex", "claude", "grok", "opencode", "antigravity"]) {
    const b = agg.byProvider[p];
    if (!b || (b.costUsd === 0 && b.totalTokens === 0)) continue;
    const est = p === "antigravity" ? " est." : "";
    parts.push(`${PROVIDER_LABEL[p]} ${fmtUsd(b.costUsd)} ${fmtTokens(b.totalTokens)}${est}`);
  }
  const lastPushAt = await getMeta("lastPushAt");
  const upd = lastPushAt ? `Updated ${ago(Date.now() - Date.parse(lastPushAt))}` : "No push timestamp";
  return { text: `Usage ${day} ${fmtUsd(total)} (${parts.join(", ")}) ${upd}`, total };
}

async function sendTelegram(text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return false;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text }),
      signal: AbortSignal.timeout(15000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

async function sendEmailFallback(text: string): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  const to = process.env.DIGEST_EMAIL_TO;
  if (!key || !to) return false;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ from: "usage-dash <digest@localhost>", to, subject: "AI usage digest", text }),
      signal: AbortSignal.timeout(15000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

export async function runDigestOnce(reason: string): Promise<{ status: string; day?: string; total?: number; reason: string }> {
  const day = await lastDay();
  if (!day) return { status: "skip", reason: "no data" };
  const built = await buildDigestText(day);
  if (!built) return { status: "skip", reason: "empty day", day };
  const threshold = Number(process.env.ALERT_THRESHOLD_USD ?? 20);
  const msg = built.total > threshold ? `ALERT over $${threshold}: ${built.text}` : built.text;
  const okTg = await sendTelegram(msg);
  const okMail = okTg ? true : await sendEmailFallback(msg);
  return { status: okTg || okMail ? "sent" : "no-channel", reason, day, total: built.total };
}
