import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface Rate {
  inputPer1M: number;
  outputPer1M: number;
  cacheReadPer1M: number;
  cacheWritePer1M: number;
}

const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const MODELS_DEV_URL = "https://models.dev/api.json";

// Built-in fallback so --dry-run works offline. USD per 1M tokens.
const FALLBACK: Array<[string, Rate]> = [
  ["claude-opus-4", { inputPer1M: 15, outputPer1M: 75, cacheReadPer1M: 1.5, cacheWritePer1M: 18.75 }],
  ["claude-sonnet-4", { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75 }],
  ["claude-3-7-sonnet", { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75 }],
  ["claude-3-5-sonnet", { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75 }],
  ["claude-3-5-haiku", { inputPer1M: 0.8, outputPer1M: 4, cacheReadPer1M: 0.08, cacheWritePer1M: 1 }],
  ["claude-haiku", { inputPer1M: 0.8, outputPer1M: 4, cacheReadPer1M: 0.08, cacheWritePer1M: 1 }],
  ["gpt-5", { inputPer1M: 1.25, outputPer1M: 10, cacheReadPer1M: 0.125, cacheWritePer1M: 1.25 }],
  ["gpt-4o", { inputPer1M: 2.5, outputPer1M: 10, cacheReadPer1M: 1.25, cacheWritePer1M: 2.5 }],
  ["gpt-4.1", { inputPer1M: 2, outputPer1M: 8, cacheReadPer1M: 0.5, cacheWritePer1M: 2 }],
  ["o3", { inputPer1M: 2, outputPer1M: 8, cacheReadPer1M: 0.5, cacheWritePer1M: 2 }],
  ["grok-4", { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.75, cacheWritePer1M: 3 }],
  ["grok-3", { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.75, cacheWritePer1M: 3 }],
  ["grok-code", { inputPer1M: 0.2, outputPer1M: 1.5, cacheReadPer1M: 0.02, cacheWritePer1M: 0.2 }],
  ["gemini-2.5-pro", { inputPer1M: 1.25, outputPer1M: 10, cacheReadPer1M: 0.31, cacheWritePer1M: 1.25 }],
  ["gemini-2.5-flash", { inputPer1M: 0.3, outputPer1M: 2.5, cacheReadPer1M: 0.075, cacheWritePer1M: 0.3 }],
  ["gemini-flash", { inputPer1M: 0.3, outputPer1M: 2.5, cacheReadPer1M: 0.075, cacheWritePer1M: 0.3 }],
  ["default", { inputPer1M: 2, outputPer1M: 8, cacheReadPer1M: 0.5, cacheWritePer1M: 2 }],
];

function cacheDir(): string {
  const base = process.env.PRICING_CACHE_DIR
    || path.join(os.homedir(), ".usage-dash");
  fs.mkdirSync(base, { recursive: true });
  return base;
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9._-]+/g, "");
}

export class Pricer {
  rates: Array<[string, Rate]> = [...FALLBACK];
  stale = false;
  source = "fallback";

  static async load(): Promise<Pricer> {
    const p = new Pricer();
    await p.refresh();
    return p;
  }

  private async refresh(): Promise<void> {
    const dir = cacheDir();
    const file = path.join(dir, "pricing.json");
    const freshMs = 24 * 3600 * 1000;
    try {
      const st = fs.statSync(file);
      if (Date.now() - st.mtimeMs < freshMs) {
        const raw = JSON.parse(fs.readFileSync(file, "utf8"));
        if (Array.isArray(raw) && raw.length > 5) {
          this.rates = [...raw, ...FALLBACK];
          this.source = "cache";
          return;
        }
      }
    } catch { /* miss */ }
    try {
      const [lite, mdev] = await Promise.all([
        fetch(LITELLM_URL, { signal: AbortSignal.timeout(8000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
        fetch(MODELS_DEV_URL, { signal: AbortSignal.timeout(8000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ]);
      const parsed: Array<[string, Rate]> = [];
      if (lite && typeof lite === "object") {
        for (const [k, v] of Object.entries<any>(lite)) {
          if (!v || typeof v !== "object") continue;
          const inp = Number(v.input_cost_per_token ?? v.input_cost_per_request ?? NaN);
          const out = Number(v.output_cost_per_token ?? NaN);
          if (!Number.isFinite(inp) || !Number.isFinite(out)) continue;
          parsed.push([norm(k), {
            inputPer1M: inp * 1e6,
            outputPer1M: out * 1e6,
            cacheReadPer1M: Number(v.cache_read_input_token_cost) * 1e6 || inp * 1e6 * 0.25,
            cacheWritePer1M: Number(v.cache_creation_input_token_cost) * 1e6 || inp * 1e6,
          }]);
        }
      }
      if (mdev && typeof mdev === "object") {
        const walk = (o: any) => {
          if (!o || typeof o !== "object") return;
          for (const v of Object.values<any>(o)) {
            if (v?.models && typeof v.models === "object") {
              for (const [mid, m] of Object.entries<any>(v.models)) {
                const c = m?.cost;
                if (c && (c.input || c.output)) {
                  parsed.push([norm(mid), {
                    inputPer1M: Number(c.input) || 0,
                    outputPer1M: Number(c.output) || 0,
                    cacheReadPer1M: Number(c.cache_read) || Number(c.input) * 0.25 || 0,
                    cacheWritePer1M: Number(c.cache_write) || Number(c.input) || 0,
                  }]);
                }
              }
            } else if (typeof v === "object") walk(v);
          }
        };
        walk(mdev);
      }
      if (parsed.length > 20) {
        this.rates = [...parsed, ...FALLBACK];
        this.source = "network";
        fs.writeFileSync(file, JSON.stringify(parsed.slice(0, 5000)));
        return;
      }
      // reuse last good even if stale
      try {
        const raw = JSON.parse(fs.readFileSync(file, "utf8"));
        if (Array.isArray(raw) && raw.length > 5) {
          this.rates = [...raw, ...FALLBACK];
          this.source = "cache-stale";
          this.stale = true;
          return;
        }
      } catch { /* none */ }
      this.stale = false;
    } catch {
      this.stale = true;
      try {
        const raw = JSON.parse(fs.readFileSync(file, "utf8"));
        if (Array.isArray(raw) && raw.length > 5) {
          this.rates = [...raw, ...FALLBACK];
          this.source = "cache-stale";
        }
      } catch { /* fallback */ }
    }
  }

  findRate(model: string): Rate | null {
    const n = norm(model || "");
    if (!n) return null;
    // Prefer an exact provider-neutral model. Reverse substring matching let
    // longer entries such as `azureusgpt-5.6-sol` override `gpt-5.6-sol`.
    const exact = this.rates.find(([key]) => key === n);
    if (exact) return exact[1];
    // Otherwise use the longest known model contained in the reported name.
    let best: Rate | null = null;
    let bestLen = 0;
    for (const [key, rate] of this.rates) {
      if (key === "default") continue;
      if (n.includes(key)) {
        if (key.length > bestLen) {
          best = rate;
          bestLen = key.length;
        }
      }
    }
    return best;
  }

  price(model: string, t: { uncached: number; cached: number; cacheCreation: number; output: number }, reported: number | null): { costUsd: number; source: "reported" | "priced" | "unpriced" } {
    if (reported != null && Number.isFinite(reported) && reported >= 0) {
      return { costUsd: reported, source: "reported" };
    }
    // OpenCode Zen free-tier models (`*-free`) are $0 by definition. Without
    // this they substring-match paid rates (e.g. `deepseek-v4-flash-free`
    // matching `deepseek-v4-flash`) and invent costs. Tokens are still kept.
    if (norm(model).endsWith("-free")) {
      return { costUsd: 0, source: "priced" };
    }
    const r = this.findRate(model);
    if (!r) {
      const d = FALLBACK.find(([k]) => k === "default")![1];
      const c = (t.uncached / 1e6) * d.inputPer1M + (t.cached / 1e6) * d.cacheReadPer1M
        + (t.cacheCreation / 1e6) * d.cacheWritePer1M + (t.output / 1e6) * d.outputPer1M;
      // Still counts as priced via generic default so totals are useful, but flag unpriced only when model unknown AND reported missing?
      // Spec: unpriced = tokens counted, cost 0. Use generic default only as last resort for estimated (antigravity);
      // for measured providers with unknown model, return 0 to avoid inventing costs.
      void c;
      return { costUsd: 0, source: "unpriced" };
    }
    const cost = (t.uncached / 1e6) * r.inputPer1M + (t.cached / 1e6) * r.cacheReadPer1M
      + (t.cacheCreation / 1e6) * r.cacheWritePer1M + (t.output / 1e6) * r.outputPer1M;
    return { costUsd: cost, source: "priced" };
  }

  /** Cost for estimated token counts (antigravity): always priced via table, generic default allowed. */
  priceEstimated(model: string, t: { uncached: number; cached: number; cacheCreation: number; output: number }): number {
    const r = this.findRate(model) ?? FALLBACK.find(([k]) => k === "default")![1];
    return (t.uncached / 1e6) * r.inputPer1M + (t.cached / 1e6) * r.cacheReadPer1M
      + (t.cacheCreation / 1e6) * r.cacheWritePer1M + (t.output / 1e6) * r.outputPer1M;
  }
}
