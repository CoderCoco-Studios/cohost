/**
 * Pluggable sub-region modules.
 *
 * Each brain region has a hook where its judgement lives — "how salient is
 * this event", "how does this line change my mood", "is this reply okay to
 * say". A hook runs one of three implementations, chosen in config:
 *
 *   rules  the built-in heuristics (default; zero latency, no dependencies)
 *   llm    ask a chat model, parsed as JSON — any provider from @cohost/llm,
 *          optionally a different/cheaper one than the cortex uses
 *   http   POST JSON to a URL you run — this is where a model you trained
 *          yourself plugs in (see examples/modules/)
 *
 * Whatever the kind, failure falls back to the rules so the show goes on.
 */
import { createChatProvider, type ChatProvider, type Config } from "@cohost/llm";
import type { Logger } from "@cohost/config";

export type ModuleConfig = Config["brain"]["salience"]["module"];

export interface ModuleImpl<I, O> {
  /** Built-in heuristic. Always present: it's the fallback. */
  rules: (input: I) => O;
  /** System prompt + user prompt for the LLM kind. The reply must be JSON matching O. */
  llm?: { system: string; user: (input: I) => string; maxTokens?: number; validate: (raw: unknown, input: I) => O | undefined };
  /** Validate what the HTTP module returned. */
  http?: { validate: (raw: unknown, input: I) => O | undefined };
}

export class Module<I, O> {
  private provider?: ChatProvider;
  private lastWarn = 0;

  constructor(
    private name: string,
    private cfg: ModuleConfig,
    private llmCfg: Config["llm"],
    private impl: ModuleImpl<I, O>,
    private log: Logger,
  ) {
    if (cfg.kind === "llm") {
      if (!impl.llm) throw new Error(`${name}: this hook has no llm implementation`);
      this.provider = createChatProvider({ ...llmCfg, ...(cfg.llm.provider ? { provider: cfg.llm.provider } : {}), ...(cfg.llm.model ? { model: cfg.llm.model } : {}) });
    }
    if (cfg.kind === "http") {
      if (!impl.http) throw new Error(`${name}: this hook has no http implementation`);
      if (!cfg.url) throw new Error(`${name}: module.kind is http but module.url is empty`);
    }
  }

  get kind(): ModuleConfig["kind"] { return this.cfg.kind; }

  async run(input: I): Promise<O> {
    if (this.cfg.kind === "rules") return this.impl.rules(input);
    try {
      const out = this.cfg.kind === "llm" ? await this.viaLlm(input) : await this.viaHttp(input);
      if (out !== undefined) return out;
      this.warn("module returned something unusable; using rules");
    } catch (err) {
      this.warn(`module failed (${String(err).slice(0, 120)}); using rules`);
    }
    return this.impl.rules(input);
  }

  private async viaLlm(input: I): Promise<O | undefined> {
    const spec = this.impl.llm!;
    const raw = await withTimeout(
      this.provider!.chat(
        [{ role: "system", content: spec.system }, { role: "user", content: spec.user(input) }],
        { maxTokens: spec.maxTokens ?? 200, temperature: 0 },
      ),
      this.cfg.timeout_ms,
    );
    return spec.validate(extractJson(raw), input);
  }

  private async viaHttp(input: I): Promise<O | undefined> {
    const res = await fetch(this.cfg.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(this.cfg.timeout_ms),
    });
    if (!res.ok) throw new Error(`http ${res.status}`);
    return this.impl.http!.validate(await res.json(), input);
  }

  private warn(msg: string): void {
    const now = Date.now();
    if (now - this.lastWarn < 30_000) return; // don't flood the log when a module is down
    this.lastWarn = now;
    this.log.warn({ module: this.name, kind: this.cfg.kind }, msg);
  }
}

/** Pull the first JSON object or array out of a chat reply (models love to add prose). */
export function extractJson(text: string): unknown {
  const m = /[\[{][\s\S]*[\]}]/.exec(text);
  if (!m) return undefined;
  try { return JSON.parse(m[0]); } catch { return undefined; }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

export const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
export const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
