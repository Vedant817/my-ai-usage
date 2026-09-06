"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchSummary, readCache, writeCache, type Summary } from "../lib/api";
import { fmtFull, fmtTokens, fmtUsd, shiftDay, shortDay, timeAgo, todayLocal } from "../lib/format";

const ORDER = ["codex", "claude", "grok", "opencode", "antigravity", "zed"] as const;
const LABEL: Record<string, string> = {
  codex: "Codex", claude: "Claude", grok: "Grok", opencode: "OpenCode", antigravity: "Antigravity", zed: "Zed",
};
const DOT: Record<string, string> = {
  codex: "#1c1917", claude: "#9a3412", grok: "#155e75", opencode: "#3f6212", antigravity: "#a8a29e", zed: "#475569",
};

function useDayParam(): [string, (d: string) => void] {
  const [day, setDay] = useState<string>(() => {
    if (typeof window === "undefined") return todayLocal();
    const q = new URLSearchParams(window.location.search).get("day");
    return /^\d{4}-\d{2}-\d{2}$/.test(q ?? "") ? (q as string) : todayLocal();
  });
  const set = useCallback((d: string) => {
    setDay(d);
    try {
      const u = new URL(window.location.href);
      u.searchParams.set("day", d);
      window.history.replaceState(null, "", u.toString());
    } catch { /* ignore */ }
  }, []);
  return [day, set];
}

export default function Page() {
  const [day, setDay] = useDayParam();
  const [data, setData] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const cached = readCache();
    if (cached) {
      setData(cached);
      setLoading(false);
    }
    const ctrl = new AbortController();
    fetchSummary(day, ctrl.signal)
      .then((s) => {
        if (cancelled) return;
        setData(s);
        writeCache(s);
        setError(null);
      })
      .catch((e) => {
        if (cancelled || (e as Error)?.name === "AbortError") return;
        if (!cached) setError(e instanceof Error ? e.message : "Failed to load");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [day]);

  const maxDaily = useMemo(
    () => Math.max(1, ...(data?.daily.map((d) => d.costUsd) ?? [1])),
    [data],
  );

  const showSkeleton = loading && !data;

  return (
    <main className="page">
      <header className="masthead">
        <div className="brand">Usage<small>AI CODING LEDGER</small></div>
        <nav className="date-nav" aria-label="Day">
          <button onClick={() => setDay(shiftDay(day, -1))} aria-label="Previous day">←</button>
          <input
            type="date" value={day} max={todayLocal()}
            onChange={(e) => e.target.value && setDay(e.target.value)}
            aria-label="Select day"
          />
          <button onClick={() => setDay(shiftDay(day, 1))} disabled={day >= todayLocal()} aria-label="Next day">→</button>
        </nav>
      </header>

      {data?.isStale && data.lastPushAt ? (
        <div className="stale" role="status">
          Updated {timeAgo(data.lastPushAt)} — PC offline, showing last data{data.day !== data.requestedDay ? ` (${data.day})` : ""}.
        </div>
      ) : data && !loading ? (
        <div className="fresh">
          <span>{data.day === todayLocal() ? "Today" : shortDay(data.day)} · {data.day}</span>
          <span>Updated {timeAgo(data.lastPushAt)}</span>
        </div>
      ) : null}

      {error && !data ? (
        <div className="section">
          <div className="empty">
            Couldn&apos;t reach the API ({error}). Check <code>NEXT_PUBLIC_API_URL</code> and{" "}
            <code>NEXT_PUBLIC_READ_TOKEN</code>. Previously cached data will appear here once loaded.
          </div>
        </div>
      ) : null}

      {showSkeleton ? (
        <>
          <div className="hero"><div className="skel pulse" style={{ height: 18, width: 140 }} /><div className="skel pulse" style={{ height: 44, width: 200, marginTop: 12 }} /></div>
          <div className="section"><div className="skel pulse" style={{ height: 120 }} /></div>
        </>
      ) : data ? (
        <>
          <section className="hero" aria-label="Totals">
            <div className="hero-label">Total spend</div>
            <div className="hero-day">{data.day} · {data.sessions} sessions</div>
            <div className="hero-grid">
              <div>
                <div className="hero-cost">{fmtUsd(data.costUsd)}</div>
                <div className="hero-sub">USD across {Object.values(data.byProvider).filter((b) => b.totalTokens > 0).length} providers</div>
              </div>
              <div>
                <div className="hero-num">{fmtTokens(data.totalTokens)}</div>
                <div className="hero-sub">tokens · {fmtFull(data.totalTokens)}</div>
              </div>
              <div>
                <div className="hero-num">{data.sessions}</div>
                <div className="hero-sub">sessions</div>
              </div>
            </div>
          </section>

          <section className="section" aria-label="By provider">
            <h2>By provider</h2>
            {ORDER.map((p) => {
              const b = data.byProvider[p];
              if (!b) return null;
              const share = data.costUsd > 0 ? (b.costUsd / data.costUsd) * 100 : 0;
              return (
                <div className="prow" key={p}>
                  <span className="dot" style={{ background: DOT[p] }} aria-hidden />
                  <div>
                    <div className="pname">
                      {LABEL[p]}
                      {p === "antigravity" ? <span className="est">est.</span> : null}
                    </div>
                    <div className="psub">
                      {fmtTokens(b.totalTokens)} tokens · {b.sessions} sessions · {b.records} records
                    </div>
                  </div>
                  <div className="pval">
                    <span className="amt">{fmtUsd(b.costUsd)}</span>
                    <span className="shr">{share.toFixed(0)}%</span>
                  </div>
                  <div className="sharebar" aria-hidden><i style={{ width: `${Math.min(100, share).toFixed(1)}%`, background: DOT[p] }} /></div>
                </div>
              );
            })}
          </section>

          <section className="section" aria-label="Last 30 days">
            <h2>Last 30 days</h2>
            {data.daily.length === 0 ? (
              <div className="empty">No history yet — push from the collector first.</div>
            ) : (
              <>
                <div className="bars">
                  {data.daily.map((d) => (
                    <div key={d.day} className={d.day === data.day ? "bar today" : "bar"} title={`${d.day} · ${fmtUsd(d.costUsd)} · ${fmtTokens(d.totalTokens)}`}>
                      <i style={{ height: `${Math.max(2, Math.round((d.costUsd / maxDaily) * 72))}px` }} />
                      <span>{d.day.slice(8)}</span>
                    </div>
                  ))}
                </div>
                <div className="bar-legend">
                  <span>{data.daily[0]?.day} → {data.daily[data.daily.length - 1]?.day}</span>
                  <span>peak {fmtUsd(maxDaily)}/day</span>
                </div>
              </>
            )}
          </section>

          <section className="section" aria-label="Models">
            <h2>Models</h2>
            {data.models.length === 0 ? (
              <div className="empty">No model rows for this day.</div>
            ) : (
              <table className="models">
                <thead>
                  <tr><th>Model</th><th>Provider</th><th className="num">Cost</th><th className="num">Share</th><th className="num">Tokens</th></tr>
                </thead>
                <tbody>
                  {data.models.slice(0, 25).map((m) => (
                    <tr key={`${m.provider}:${m.model}`}>
                      <td className="mname">{m.model}{m.estimated ? " *" : ""}</td>
                      <td className="mprov">{LABEL[m.provider] ?? m.provider}</td>
                      <td className="num">{fmtUsd(m.costUsd)}</td>
                      <td className="num">{data.costUsd > 0 ? `${((m.costUsd / data.costUsd) * 100).toFixed(1)}%` : "—"}</td>
                      <td className="num">{fmtTokens(m.totalTokens)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <footer className="footer">
            <span>Pricing: LiteLLM + models.dev tables (cached 24h){data.models.some((m) => m.estimated) ? " · * estimated" : ""}</span>
            <span>Last push {data.lastPushAt ? timeAgo(data.lastPushAt) : "never"}</span>
          </footer>
        </>
      ) : null}
    </main>
  );
}
