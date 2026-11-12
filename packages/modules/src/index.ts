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
import type { Logger, ModuleConfig } from "@cohost/config";

/** The one definition of a hook's config lives with the schema in `@cohost/config`; re-exported so callers import it from here (CFG-SCH-027). */
export type { ModuleConfig } from "@cohost/config"; // @spec HOOK-CFG-001

/** A hook that fails this many calls in a row is skipped for `HOOK_COOLOFF_MS` (HOOK-COOL-001). */
export const HOOK_COOLOFF_AFTER = 5;
/** How long a failing hook is skipped, ms. */
export const HOOK_COOLOFF_MS = 60_000;
/** At most one fallback warning per this long per `Module`, ms. */
const WARN_WINDOW_MS = 30_000;

/** Test and wiring seams: a monotonic clock, a ready-made provider, and the cool-off threshold. */
export interface ModuleOptions {
  /** Monotonic millisecond clock (default `performance.now`). */
  now?: () => number;
  /** Use this chat provider instead of building one from config (`llm` kind only). */
  provider?: ChatProvider;
  /** Consecutive failures before the cool-off (default `HOOK_COOLOFF_AFTER`). */
  coolOffAfter?: number;
  /** Cool-off length, ms (default `HOOK_COOLOFF_MS`). */
  coolOffMs?: number;
}

/** What a hook reports about itself for the heartbeat. */
export interface HookHealth {
  name: string;
  kind: ModuleConfig["kind"];
  /** The chat provider an `llm` hook runs on. */
  provider?: string;
  /** True when that provider is the mock. */
  mock: boolean;
  /** True/false after a ping or a call; undefined while unknown (never checked, or a nominal ping). */
  reachable: boolean | undefined;
  coolingOff: boolean;
  /** The provider's `lastError` after a failed ping. */
  detail?: string;
}

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
  private lastWarn?: number;
  private suppressed = 0;
  private failures = 0;
  private coolUntil?: number;
  private reachable: boolean | undefined;
  private readonly now: () => number;
  private readonly coolOffAfter: number;
  private readonly coolOffMs: number;

  constructor(
    private name: string,
    private cfg: ModuleConfig,
    private llmCfg: Config["llm"],
    private impl: ModuleImpl<I, O>,
    private log: Logger,
    opts: ModuleOptions = {},
  ) {
    this.now = opts.now ?? (() => performance.now());
    this.coolOffAfter = opts.coolOffAfter ?? HOOK_COOLOFF_AFTER;
    this.coolOffMs = opts.coolOffMs ?? HOOK_COOLOFF_MS;
    if (cfg.kind === "llm") {
      if (!impl.llm) throw new Error(`${name}: this hook has no llm implementation`); // @spec HOOK-KIND-003
      this.provider = opts.provider ?? createChatProvider({ ...llmCfg, ...(cfg.llm.provider ? { provider: cfg.llm.provider } : {}), ...(cfg.llm.model ? { model: cfg.llm.model } : {}) }); // @spec HOOK-LLM-001, HOOK-LLM-002
      if (this.provider.name === "mock") log.warn({ module: name, kind: cfg.kind }, `${name}: running on the mock provider, so every call falls back to rules`); // @spec HOOK-WARN-004
    }
    if (cfg.kind === "http") {
      if (!impl.http) throw new Error(`${name}: this hook has no http implementation`); // @spec HOOK-KIND-004
      if (!cfg.url) throw new Error(`${name}: module.kind is http but module.url is empty`); // @spec HOOK-KIND-005
    }
  }

  get kind(): ModuleConfig["kind"] { return this.cfg.kind; } // @spec HOOK-KIND-002

  /** True while the hook is being skipped after repeated failures (HOOK-COOL-001). */
  get coolingOff(): boolean { return this.coolUntil !== undefined && this.now() < this.coolUntil; }

  /** The hook's standing as the heartbeat reports it. */
  health(): HookHealth { // @spec HOOK-HEALTH-001, HOOK-HEALTH-002, HOOK-HEALTH-003
    return {
      name: this.name,
      kind: this.cfg.kind,
      ...(this.provider ? { provider: this.provider.name } : {}),
      mock: this.provider?.name === "mock",
      reachable: this.reachable,
      coolingOff: this.coolingOff,
      ...(this.reachable === false && this.provider?.lastError ? { detail: this.provider.lastError } : {}),
    };
  }

  /**
   * Ask an `llm` hook's provider whether it answers, and remember the answer. `undefined` for kinds with nothing
   * to ping. A provider whose ping is nominal (bedrock) answers true but leaves the reachable flag unknown.
   */
  async ping(): Promise<boolean | undefined> { // @spec HOOK-HEALTH-001, HOOK-HEALTH-002
    if (!this.provider) return undefined;
    let ok: boolean;
    try { ok = await this.provider.ping(); } catch (err) { this.provider.lastError = String(err); ok = false; }
    this.reachable = ok && this.provider.pingIsNominal ? undefined : ok;
    return ok;
  }

  async run(input: I): Promise<O> { // @spec HOOK-FALLBACK-001, HOOK-FALLBACK-002, HOOK-FALLBACK-003, HOOK-FALLBACK-004
    if (this.cfg.kind === "rules") return this.impl.rules(input); // @spec HOOK-KIND-001, HOOK-FALLBACK-005
    if (this.coolingOff) return this.impl.rules(input); // @spec HOOK-COOL-001
    try {
      const out = this.cfg.kind === "llm" ? await this.viaLlm(input) : await this.viaHttp(input);
      if (out !== undefined) { this.succeeded(); return out; }
      this.failed();
      this.warn("module returned something unusable; using rules"); // @spec HOOK-WARN-002
    } catch (err) {
      this.failed();
      this.warn(`module failed (${String(err).slice(0, 120)}); using rules`); // @spec HOOK-WARN-002
    }
    return this.impl.rules(input);
  }

  private succeeded(): void { // @spec HOOK-COOL-002
    this.failures = 0;
    this.coolUntil = undefined;
    this.reachable = true;
  }

  private failed(): void { // @spec HOOK-COOL-001
    this.reachable = false;
    if (++this.failures < this.coolOffAfter) return;
    this.coolUntil = this.now() + this.coolOffMs;
    this.log.warn({ module: this.name, kind: this.cfg.kind, failures: this.failures },
      `${this.name}: ${this.failures} failures in a row; cooling off for ${Math.round(this.coolOffMs / 1000)}s, using rules meanwhile`);
  }

  private async viaLlm(input: I): Promise<O | undefined> { // @spec HOOK-LLM-003, HOOK-LLM-004, HOOK-LLM-005
    const spec = this.impl.llm!;
    const raw = await withTimeout(
      (signal) => this.provider!.chat(
        [{ role: "system", content: spec.system }, { role: "user", content: spec.user(input) }],
        { maxTokens: spec.maxTokens ?? 200, temperature: 0, json: true, signal },
      ),
      this.cfg.timeout_ms,
    );
    return spec.validate(extractJson(raw), input);
  }

  private async viaHttp(input: I): Promise<O | undefined> { // @spec HOOK-HTTP-001, HOOK-HTTP-002
    const raw = await withTimeout(async (signal) => {
      const res = await fetch(this.cfg.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
        signal,
      });
      if (!res.ok) throw new Error(`http ${res.status}`); // @spec HOOK-HTTP-003
      return (await res.json()) as unknown;
    }, this.cfg.timeout_ms);
    return this.impl.http!.validate(raw, input);
  }

  private warn(msg: string): void { // @spec HOOK-WARN-001
    const now = this.now();
    if (this.lastWarn !== undefined && now - this.lastWarn < WARN_WINDOW_MS) { this.suppressed++; return; } // don't flood the log when a module is down
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

/**
 * Run `fn` with a signal that aborts at `ms`. The timer both rejects the call and aborts the signal, so a
 * cooperative provider stops its request and an uncooperative one cannot hold `run` past the deadline
 * (HOOK-LLM-004, HOOK-LLM-006).
 */
function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> { // @spec HOOK-LLM-004, HOOK-LLM-006
  const ctl = new AbortController();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      const err = new Error(`timeout after ${ms}ms`);
      reject(err);
      ctl.abort(err);
    }, ms);
    fn(ctl.signal).then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** Heartbeat parts for a service that runs hooks: `mock` when any hook sits on the mock provider, plus one dependency per non-rules hook. */
export function hookHealth(hooks: Module<never, unknown>[]): { mode: () => "live" | "mock"; deps: () => Record<string, "ok" | "down" | "n/a"> } { // @spec HOOK-HEALTH-004
  return {
    mode: () => (hooks.some((h) => h.health().mock) ? "mock" : "live"),
    deps: () => {
      const deps: Record<string, "ok" | "down" | "n/a"> = {};
      for (const h of hooks) {
        const s = h.health();
        if (s.kind === "rules") continue;
        deps[`hook.${s.name}`] = s.coolingOff || s.reachable === false ? "down" : s.reachable ? "ok" : "n/a";
      }
      return deps;
    },
  };
}

/** Ping every non-rules hook once (at startup) and warn about the ones that do not answer; never throws. */
export async function pingHooks(hooks: Module<never, unknown>[], log: Logger): Promise<void> { // @spec HOOK-HEALTH-005
  await Promise.all(hooks.map(async (h) => {
    const ok = await h.ping();
    if (ok === false) log.warn({ module: h.health().name, kind: h.kind }, `${h.health().name}: hook provider unreachable${h.health().detail ? ` (${h.health().detail})` : ""}; calls will fall back to rules`);
  }));
}

export const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x)); // @spec HOOK-HELP-004
export const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x); // @spec HOOK-HELP-004
export { HOOK_REPLY_SCHEMAS, type HookName } from "./schemas.js";
