"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiBase, fetchSummary, readCache, writeCache, type Summary } from "../lib/api";
import { fmtFull, fmtTokens, fmtUsd, shiftDay, shortDay, timeAgo, todayLocal } from "../lib/format";

const ORDER = ["codex", "claude", "grok", "opencode", "antigravity"] as const;
type Filter = "all" | (typeof ORDER)[number];
const LABEL: Record<string, string> = {
  codex: "Codex", claude: "Claude", grok: "Grok", opencode: "OpenCode", antigravity: "Antigravity",
};
const DOT: Record<string, string> = {
  codex: "#1c1917", claude: "#9a3412", grok: "#155e75", opencode: "#3f6212", antigravity: "#a8a29e",
};
const RANGES = [30, 60, 90] as const;

function useDayParam(): [string, (d: string) => void] {
  // NOTE: intentionally NOT reading ?day= here. This initializer runs on the
  // server during SSR (no window) and again on the client — returning different
  // values would cause a hydration mismatch. The query param is applied in the
  // effect below (client-only), after hydration.
  const [day, setDay] = useState<string>(() => todayLocal());

  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("day");
    if (/^\d{4}-\d{2}-\d{2}$/.test(q ?? "")) setDay(q as string);
  }, []);
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

function shiftDayStr(day: string, delta: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(y, m - 1, d + delta);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}

/** Compact axis number: 1.5T, 2B, 150M, 50k, 0. */
function axisNum(n: number): string {
  if (n >= 1e12) return `${trim(n / 1e12)}T`;
  if (n >= 1e9) return `${trim(n / 1e9)}B`;
  if (n >= 1e6) return `${trim(n / 1e6)}M`;
  if (n >= 1e3) return `${trim(n / 1e3)}k`;
  return `${Math.round(n)}`;
}
function trim(n: number): string {
  return n >= 100 ? `${Math.round(n)}` : `${Math.round(n * 10) / 10}`;
}
function axisMoney(n: number): string {
  if (n >= 1000) return `$${trim(n / 1000)}k`;
  if (Number.isInteger(n)) return `$${n}`;
  return `$${n.toFixed(n < 10 ? 1 : 0)}`;
}

function niceCeil(v: number): number {
  if (!(v > 0)) return 1;
  const exp = Math.floor(Math.log10(v));
  const base = Math.pow(10, exp);
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (m * base >= v) return m * base;
  }
  return 10 * base;
}

interface ChartDatum { day: string; value: number }

function AreaChart({ data, money }: { data: ChartDatum[]; money: boolean }) {
  const W = 800, H = 250, L = 52, R = 10, T = 12, B = 26;
  const iw = W - L - R, ih = H - T - B;
  const maxData = Math.max(0, ...data.map((d) => d.value));
  const step = niceCeil(maxData / 3 || 1);
  const max = step * 3;
  const x = (i: number) => (data.length <= 1 ? L : L + (i / (data.length - 1)) * iw);
  const y = (v: number) => T + ih * (1 - (max > 0 ? v / max : 0));
  const r1 = (n: number) => Math.round(n * 10) / 10;

  const pts = data.map((d, i) => ({ x: r1(x(i)), y: r1(y(d.value)) }));
  let line = "";
  if (pts.length === 1) {
    line = `M ${L} ${pts[0].y} L ${L + iw} ${pts[0].y}`;
  } else if (pts.length > 1) {
    line = `M ${pts[0].x} ${pts[0].y}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
      line += ` C ${r1(p1.x + (p2.x - p0.x) / 6)} ${r1(p1.y + (p2.y - p0.y) / 6)}, ${r1(p2.x - (p3.x - p1.x) / 6)} ${r1(p2.y - (p3.y - p1.y) / 6)}, ${p2.x} ${p2.y}`;
    }
  }
  const base = T + ih;
  const area = line ? `${line} L ${r1(x(data.length - 1))} ${base} L ${L} ${base} Z` : "";
  const ticks = [0, 1, 2, 3].map((i) => step * i);
  const fmtTick = (v: number) => (money ? axisMoney(v) : axisNum(v));
  const labelIdx = data.length <= 4
    ? data.map((_, i) => i)
    : [0, Math.round((data.length - 1) / 3), Math.round((2 * (data.length - 1)) / 3), data.length - 1];
  const fmtDay = (day: string) => {
    const [yy, mm, dd] = day.split("-").map(Number);
    return new Date(yy, mm - 1, dd)
      .toLocaleDateString("en-US", { month: "short", day: "numeric" })
      .replace(",", "").toUpperCase();
  };

  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Daily usage chart" style={{ width: "100%", height: "auto", display: "block" }}>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={L} x2={W - R} y1={r1(y(t))} y2={r1(y(t))} stroke="rgba(255,255,255,0.14)" strokeWidth={1} />
          <text x={L - 8} y={r1(y(t)) + 4} textAnchor="end" fontSize={12} fill="#a8a29e" style={{ fontVariantNumeric: "tabular-nums" }}>
            {fmtTick(t)}
          </text>
        </g>
      ))}
      {area ? <path d={area} fill="rgba(255,255,255,0.07)" /> : null}
      {line ? <path d={line} fill="none" stroke="#fafaf9" strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" /> : null}
      {labelIdx.map((i, k) => (
        <text key={i} x={k === labelIdx.length - 1 ? W - R - 2 : r1(x(i))} y={H - 8} textAnchor={k === labelIdx.length - 1 ? "end" : "middle"} fontSize={11} letterSpacing={1} fill="#a8a29e">
          {fmtDay(data[i].day)}
        </text>
      ))}
    </svg>
  );
}

export default function Page() {
  const [day, setDay] = useDayParam();
  const [range, setRange] = useState<number>(30);
  const [filter, setFilter] = useState<Filter>("all");
  const [metric, setMetric] = useState<"tokens" | "cost">("tokens");
  const [data, setData] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const cached = readCache(day, range);
    if (cached) {
      setData(cached);
      setLoading(false);
    } else {
      setLoading(true);
    }
    const ctrl = new AbortController();
    fetchSummary(day, range, ctrl.signal)
      .then((s) => {
        if (cancelled) return;
        setData(s);
        writeCache(s, day, range);
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
  }, [day, range]);

  const sel: string | null = filter === "all" ? null : filter;

  const dayAgg = useMemo(() => {
    if (!data) return { cost: 0, tokens: 0, sessions: 0, providers: 0 };
    if (!sel) return { cost: data.costUsd, tokens: data.totalTokens, sessions: data.sessions, providers: Object.values(data.byProvider).filter((b) => b.totalTokens > 0).length };
    const b = data.byProvider[sel];
    if (!b) return { cost: 0, tokens: 0, sessions: 0, providers: 0 };
    return { cost: b.costUsd, tokens: b.totalTokens, sessions: b.sessions, providers: 1 };
  }, [data, sel]);

  // Continuous zero-filled series across the requested range.
  const series = useMemo(() => {
    if (!data || data.daily.length === 0) return [] as ChartDatum[];
    const endDay = data.daily[data.daily.length - 1].day;
    const byDay = new Map(data.daily.map((d) => [d.day, d]));
    const out: ChartDatum[] = [];
    for (let i = range - 1; i >= 0; i--) {
      const d = shiftDayStr(endDay, -i);
      const row = byDay.get(d);
      const v = row
        ? sel
          ? (metric === "tokens" ? row.byProvider[sel]?.totalTokens ?? 0 : row.byProvider[sel]?.costUsd ?? 0)
          : metric === "tokens" ? row.totalTokens : row.costUsd
        : 0;
      out.push({ day: d, value: v });
    }
    return out;
  }, [data, range, sel, metric]);

  const rangeAgg = useMemo(() => {
    let cost = 0, tokens = 0;
    if (data && data.daily.length) {
      const byDay = new Map(data.daily.map((d) => [d.day, d]));
      const endDay = data.daily[data.daily.length - 1].day;
      for (let i = range - 1; i >= 0; i--) {
        const row = byDay.get(shiftDayStr(endDay, -i));
        if (!row) continue;
        if (!sel) { tokens += row.totalTokens; cost += row.costUsd; }
        else { tokens += row.byProvider[sel]?.totalTokens ?? 0; cost += row.byProvider[sel]?.costUsd ?? 0; }
      }
    }
    return { cost: Math.round(cost * 10000) / 10000, tokens: Math.round(tokens) };
  }, [data, range, sel]);

  const rangeByProvider = useMemo(() => {
    const totals: Record<string, { tokens: number; cost: number }> = {};
    for (const p of ORDER) totals[p] = { tokens: 0, cost: 0 };
    for (const row of data?.daily ?? []) {
      for (const p of ORDER) {
        totals[p].tokens += row.byProvider[p]?.totalTokens ?? 0;
        totals[p].cost += row.byProvider[p]?.costUsd ?? 0;
      }
    }
    return totals;
  }, [data]);

  // Models follow the selected range (like cards/chart), not just the day.
  const models = useMemo(() => {
    if (!data || data.daily.length === 0) return [];
    const byDay = new Map(data.daily.map((d) => [d.day, d]));
    const endDay = data.daily[data.daily.length - 1].day;
    const acc = new Map<string, { provider: string; model: string; totalTokens: number; costUsd: number; estimated?: boolean }>();
    for (let i = range - 1; i >= 0; i--) {
      const row = byDay.get(shiftDayStr(endDay, -i));
      if (!row) continue;
      for (const m of row.models ?? []) {
        if (sel && m.provider !== sel) continue;
        const key = `${m.provider}\0${m.model}`;
        if (!acc.has(key)) acc.set(key, { provider: m.provider, model: m.model, totalTokens: 0, costUsd: 0 });
        const a = acc.get(key)!;
        a.totalTokens += m.totalTokens;
        a.costUsd += m.costUsd;
        a.estimated = a.estimated || m.estimated;
      }
    }
    return [...acc.values()]
      .map((m) => ({ ...m, costUsd: Math.round(m.costUsd * 10000) / 10000 }))
      .sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens)
      .slice(0, 25);
  }, [data, range, sel]);

  const showSkeleton = loading && !data;
  const rangeLabel = `LAST ${range}D`;
  const plottedTotal = metric === "tokens" ? rangeAgg.tokens : rangeAgg.cost;

  return (
    <main className="page wide">
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
          <span>{data.day === todayLocal() ? "Today" : shortDay(data.day)} · {data.day}{sel ? ` · ${LABEL[sel]}` : ""}</span>
          <span>Updated {timeAgo(data.lastPushAt)}</span>
        </div>
      ) : null}

      {error && !data ? (
        <div className="section">
          <div className="empty">
            Couldn&apos;t reach the API at {apiBase() || "(not configured)"} ({error}).
            {apiBase()
              ? " Is the API server running there? Check the server process and CORS."
              : " Set NEXT_PUBLIC_API_URL and NEXT_PUBLIC_READ_TOKEN, then restart."}{" "}
            Previously cached data will appear here once loaded.
          </div>
        </div>
      ) : null}

      {showSkeleton ? (
        <>
          <div className="kpis">
            {[0, 1, 2, 3].map((i) => <div key={i} className="kpi"><div className="skel pulse" style={{ height: 34 }} /></div>)}
          </div>
          <div className="section dark"><div className="skel pulse" style={{ height: 220 }} /></div>
        </>
      ) : data ? (
        <>
          <section className="kpis" aria-label="Totals">
            <div className="kpi">
              <div className="kpi-label">Day cost · {shortDay(data.day)}</div>
              <div className="kpi-num">{fmtUsd(dayAgg.cost)}</div>
              <div className="kpi-sub">{dayAgg.sessions} sessions · {dayAgg.providers} provider{dayAgg.providers === 1 ? "" : "s"}</div>
            </div>
            <div className="kpi">
              <div className="kpi-label">Day tokens</div>
              <div className="kpi-num">{fmtTokens(dayAgg.tokens)}</div>
              <div className="kpi-sub">{fmtFull(dayAgg.tokens)} total</div>
            </div>
            <div className="kpi">
              <div className="kpi-label">{rangeLabel} cost</div>
              <div className="kpi-num">{fmtUsd(rangeAgg.cost)}</div>
              <div className="kpi-sub">across {range} days{sel ? ` · ${LABEL[sel]}` : ""}</div>
            </div>
            <div className="kpi">
              <div className="kpi-label">{rangeLabel} tokens</div>
              <div className="kpi-num">{fmtTokens(rangeAgg.tokens)}</div>
              <div className="kpi-sub">{fmtFull(rangeAgg.tokens)} total</div>
            </div>
          </section>

          <section className="controls" aria-label="View controls">
            <div className="seg" role="group" aria-label="Time range">
              {RANGES.map((r) => (
                <button key={r} className={range === r ? "on" : ""} onClick={() => setRange(r)}>{r}D</button>
              ))}
            </div>
            <div className="seg" role="group" aria-label="Metric">
              <button className={metric === "tokens" ? "on" : ""} onClick={() => setMetric("tokens")}>Tokens</button>
              <button className={metric === "cost" ? "on" : ""} onClick={() => setMetric("cost")}>Cost</button>
            </div>
            <div className="chips" role="group" aria-label="Provider filter">
              <button className={filter === "all" ? "on" : ""} onClick={() => setFilter("all")}>All</button>
              {ORDER.map((p) => (
                <button key={p} className={filter === p ? "on" : ""} onClick={() => setFilter(filter === p ? "all" : p)}>
                  <span className="cdot" style={{ background: DOT[p] }} aria-hidden />
                  {LABEL[p]}
                </button>
              ))}
            </div>
          </section>

          <section className="section dark" aria-label="Token consumption chart">
            <div className="chart-head">
              <h2>{metric === "tokens" ? "Token consumption" : "Cost"} · last {range} days{sel ? ` · ${LABEL[sel]}` : ""}</h2>
              <span>{metric === "tokens" ? fmtTokens(rangeAgg.tokens) : fmtUsd(rangeAgg.cost)}</span>
            </div>
            {series.length === 0 || plottedTotal === 0 ? (
              <div className="empty dark-empty">
                {metric === "cost" && rangeAgg.tokens > 0
                  ? `No cost estimate is available for the models in this range.${sel && data.coverage?.[sel]?.note ? ` ${data.coverage[sel].note}` : ""}`
                  : sel && data.coverage?.[sel]?.note
                  ? `No ${LABEL[sel]} data in this range. ${data.coverage[sel].note}`
                  : "No history yet. Push from the collector first."}
              </div>
            ) : (
              <AreaChart data={series} money={metric === "cost"} />
            )}
          </section>

          <section className="pcards" aria-label="By provider">
            {ORDER.map((p) => {
              const b = data.byProvider[p];
              if (!b) return null;
              const total = rangeByProvider[p];
              const share = rangeAgg.cost > 0 ? (total.cost / rangeAgg.cost) * 100 : 0;
              return (
                <button key={p} className={`pcard${filter === p ? " active" : ""}`} onClick={() => setFilter(filter === p ? "all" : p)} aria-pressed={filter === p}>
                  <span className="dot" style={{ background: DOT[p] }} aria-hidden />
                  <span className="pcard-name">{LABEL[p]}{p === "antigravity" ? <span className="est">est.</span> : null}</span>
                  <span className="pcard-amt">{fmtUsd(total.cost)}</span>
                  <span className="pcard-sub">{fmtTokens(total.tokens)} · last {range}D · {share.toFixed(0)}%</span>
                  <span className="pcard-source">{data.coverage?.[p]?.mode === "account" ? "Account-wide" : "This device"}</span>
                  <span className="sharebar" aria-hidden><i style={{ width: `${Math.min(100, share).toFixed(1)}%`, background: DOT[p] }} /></span>
                </button>
              );
            })}
          </section>

          <section className="section" aria-label="Models">
            <h2>Models · last {range}D{sel ? ` · ${LABEL[sel]}` : ""}</h2>
            {models.length === 0 ? (
              <div className="empty">No model rows for this view.</div>
            ) : (
              <table className="models">
                <thead>
                  <tr><th>Model</th><th>Provider</th><th className="num">Cost</th><th className="num">Share</th><th className="num">Tokens</th></tr>
                </thead>
                <tbody>
                  {models.map((m) => (
                    <tr key={`${m.provider}:${m.model}`}>
                      <td className="mname">{m.model}{m.estimated ? " *" : ""}</td>
                      <td className="mprov">{LABEL[m.provider] ?? m.provider}</td>
                      <td className="num">{fmtUsd(m.costUsd)}</td>
                      <td className="num">{rangeAgg.cost > 0 ? `${((m.costUsd / rangeAgg.cost) * 100).toFixed(1)}%` : "—"}</td>
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
