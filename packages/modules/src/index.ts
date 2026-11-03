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
 *
 * Precondition (HOOK-FALLBACK-005): `rules` must never throw and must return the
 * hook's output type for every input. There is no value to fall back to when the
 * rules fail, so `run` calls them unguarded, on the `rules` path and as the fallback.
 */
import { createChatProvider, type ChatProvider, type Config } from "@cohost/llm";
import type { Logger } from "@cohost/config";

export type ModuleConfig = Config["brain"]["salience"]["module"];

export interface ModuleImpl<I, O> {
  /** Built-in heuristic. Always present: it's the fallback. Must not throw: `run` calls it unguarded (HOOK-FALLBACK-005). */
  rules: (input: I) => O;
  /** System prompt + user prompt for the LLM kind. The reply must be JSON matching O. */
  llm?: { system: string; user: (input: I) => string; maxTokens?: number; validate: (raw: unknown, input: I) => O | undefined };
  /** Validate what the HTTP module returned. */
  http?: { validate: (raw: unknown, input: I) => O | undefined };
}

export class Module<I, O> {
  private provider?: ChatProvider;
  private lastWarn = 0;
  private suppressed = 0;

  constructor(
    private name: string,
    private cfg: ModuleConfig,
    private llmCfg: Config["llm"],
    private impl: ModuleImpl<I, O>,
    private log: Logger,
  ) {
    if (cfg.kind === "llm") {
      if (!impl.llm) throw new Error(`${name}: this hook has no llm implementation`); // @spec HOOK-KIND-003
      this.provider = createChatProvider({ ...llmCfg, ...(cfg.llm.provider ? { provider: cfg.llm.provider } : {}), ...(cfg.llm.model ? { model: cfg.llm.model } : {}) }); // @spec HOOK-LLM-001, HOOK-LLM-002
      if (this.provider.name === "mock") log.warn({ module: name, kind: cfg.kind }, `${name}: running on the mock provider, so every call falls back to rules`); // @spec HOOK-WARN-004
    }
    if (cfg.kind === "http") {
      if (!impl.http) throw new Error(`${name}: this hook has no http implementation`); // @spec HOOK-KIND-004
      if (!cfg.url) throw new Error(`${name}: module.kind is http but module.url is empty`); // @spec HOOK-KIND-005
    }
  }

  get kind(): ModuleConfig["kind"] { return this.cfg.kind; } // @spec HOOK-KIND-002

  async run(input: I): Promise<O> { // @spec HOOK-FALLBACK-001, HOOK-FALLBACK-002, HOOK-FALLBACK-003, HOOK-FALLBACK-004
    if (this.cfg.kind === "rules") return this.impl.rules(input); // @spec HOOK-KIND-001, HOOK-FALLBACK-005
    try {
      const out = this.cfg.kind === "llm" ? await this.viaLlm(input) : await this.viaHttp(input);
      if (out !== undefined) return out;
      this.warn("module returned something unusable; using rules"); // @spec HOOK-WARN-002
    } catch (err) {
      this.warn(`module failed (${String(err).slice(0, 120)}); using rules`); // @spec HOOK-WARN-002
    }
    return this.impl.rules(input);
  }

  private async viaLlm(input: I): Promise<O | undefined> { // @spec HOOK-LLM-003, HOOK-LLM-004, HOOK-LLM-005
    const spec = this.impl.llm!;
    const raw = await withTimeout(
      this.provider!.chat(
        [{ role: "system", content: spec.system }, { role: "user", content: spec.user(input) }],
        { maxTokens: spec.maxTokens ?? 200, temperature: 0, json: true, signal: AbortSignal.timeout(this.cfg.timeout_ms) },
      ),
      this.cfg.timeout_ms,
    );
    return spec.validate(extractJson(raw), input);
  }

  private async viaHttp(input: I): Promise<O | undefined> { // @spec HOOK-HTTP-001, HOOK-HTTP-002
    const res = await fetch(this.cfg.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(this.cfg.timeout_ms),
    });
    if (!res.ok) throw new Error(`http ${res.status}`); // @spec HOOK-HTTP-003
    return this.impl.http!.validate(await res.json(), input);
  }

  private warn(msg: string): void { // @spec HOOK-WARN-001
    const now = Date.now();
    if (now - this.lastWarn < 30_000) { this.suppressed++; return; } // don't flood the log when a module is down
    this.lastWarn = now;
    const suppressed = this.suppressed; // @spec HOOK-WARN-003
    this.suppressed = 0;
    this.log.warn({ module: this.name, kind: this.cfg.kind, ...(suppressed ? { suppressed } : {}) }, msg);
  }
}

/**
 * Pull the first balanced JSON object or array out of a chat reply (models love to add prose).
 * Brackets in the prose before or after the value, and braces inside its strings, do not matter;
 * a bracketed span that is not JSON (`[events]`) is skipped.
 */
export function extractJson(text: string): unknown { // @spec HOOK-HELP-001, HOOK-HELP-002, HOOK-HELP-003
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{" && text[i] !== "[") continue;
    const end = balancedEnd(text, i);
    if (end < 0) continue;
    try { return JSON.parse(text.slice(i, end + 1)); } catch { /* looks bracketed but is prose: keep scanning */ }
  }
  return undefined;
}

/** Index of the bracket that closes the one at `start`, honouring JSON strings; -1 when unbalanced or mismatched. */
function balancedEnd(text: string, start: number): number {
  const closers: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") closers.push("}");
    else if (ch === "[") closers.push("]");
    else if (ch === "}" || ch === "]") {
      if (closers.pop() !== ch) return -1;
      if (closers.length === 0) return i;
    }
  }
  return -1;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

export const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x)); // @spec HOOK-HELP-004
export const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x); // @spec HOOK-HELP-004
