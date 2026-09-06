import { aggregateDay, getMeta, lastDay } from "./db.js";

const PROVIDER_LABEL: Record<string, string> = {
  codex: "Codex", claude: "Claude", grok: "Grok", opencode: "OpenCode", antigravity: "Antigravity", zed: "Zed",
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

export function buildDigestText(day: string): string | null {
  const agg = aggregateDay(day);
  let total = 0;
  for (const b of Object.values(agg.byProvider)) total += b.costUsd;
  if (!total && Object.values(agg.byProvider).every((b) => b.totalTokens === 0)) return null;
  const parts: string[] = [];
  for (const p of ["codex", "claude", "grok", "opencode", "antigravity", "zed"]) {
    const b = agg.byProvider[p];
    if (!b || (b.costUsd === 0 && b.totalTokens === 0)) continue;
    const est = p === "antigravity" ? " est." : "";
    parts.push(`${PROVIDER_LABEL[p]} ${fmtUsd(b.costUsd)} ${fmtTokens(b.totalTokens)}${est}`);
  }
  const lastPushAt = getMeta("lastPushAt");
  const upd = lastPushAt ? `Updated ${ago(Date.now() - Date.parse(lastPushAt))}` : "No push timestamp";
  return `Usage ${day} ${fmtUsd(total)} (${parts.join(", ")}) ${upd}`;
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

export async function runDigestOnce(reason: string): Promise<void> {
  const day = lastDay();
  if (!day) {
    console.log(JSON.stringify({ digest: "skip", reason: "no data" }));
    return;
  }
  const text = buildDigestText(day);
  if (!text) {
    console.log(JSON.stringify({ digest: "skip", reason: "empty day", day }));
    return;
  }
  const threshold = Number(process.env.ALERT_THRESHOLD_USD ?? 20);
  const agg = aggregateDay(day);
  const total = Object.values(agg.byProvider).reduce((a, b) => a + b.costUsd, 0);
  const msg = total > threshold ? `ALERT over $${threshold}: ${text}` : text;
  const okTg = await sendTelegram(msg);
  const okMail = okTg ? true : await sendEmailFallback(msg);
  console.log(JSON.stringify({ digest: okTg || okMail ? "sent" : "no-channel", reason, day, total }));
}

function minutesInTz(tz: string): { h: number; m: number } {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz }).formatToParts(new Date());
    return { h: Number(parts.find((p) => p.type === "hour")?.value ?? 0), m: Number(parts.find((p) => p.type === "minute")?.value ?? 0) };
  } catch {
    const d = new Date();
    return { h: d.getHours(), m: d.getMinutes() };
  }
}

/** In-process cron: 09:00 + 21:00 local (CRON_TZ) + hourly overspend check. No-op without Telegram/email configured. */
export function maybeStartDigestLoop(): void {
  if (!process.env.TELEGRAM_BOT_TOKEN && !process.env.RESEND_API_KEY) return;
  const tz = process.env.CRON_TZ ?? "Asia/Kolkata";
  let lastSent = "";
  setInterval(() => {
    const { h, m } = minutesInTz(tz);
    const slot = h < 12 ? "am" : "pm";
    const key = `${new Date().toLocaleDateString("en-CA")}-${slot}`;
    const inWindow = (h === 9 || h === 21) && m < 5;
    if (inWindow && lastSent !== key) {
      lastSent = key;
      runDigestOnce("scheduled").catch(() => {});
    }
  }, 60_000);
}

// CLI: node digest.ts --once [--alert]
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("digest.ts")) {
  const alert = process.argv.includes("--alert");
  runDigestOnce(alert ? "alert" : "manual").then(() => process.exit(0));
}
