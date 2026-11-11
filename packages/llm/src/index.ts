/**
 * Model backends. The regions never know which one is behind `chat()`, so a
 * stronger model is a config change, not a code change:
 *
 *   ollama     local GPU (default)
 *   openai     any OpenAI-compatible endpoint: vLLM on a rented GPU box,
 *              OpenRouter, Groq, Together, Fireworks ...
 *   anthropic  Claude via the Claude API
 *   bedrock    Claude via Amazon Bedrock (AWS credentials from the environment)
 *   mock       deterministic offline replies, for isolated runs (never a default)
 *
 * Embeddings always come from Ollama: they're cheap, and switching the chat
 * model must not change the vector size of the memory table.
 */
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";
import { urls, type Config } from "@cohost/config";
import { TRANSCRIPT_TAGS } from "@cohost/working-memory";
import { MockProvider, HashEmbedder } from "./mock.js";
export type { Config };
export { MockProvider, HashEmbedder };

export interface ChatMessage { role: "system" | "user" | "assistant"; content: string }
export interface ChatOptions {
  maxTokens?: number;
  temperature?: number;
  /**
   * JSON reply wanted: send no stop sequences (a blank line or a transcript tag inside JSON would truncate it) and,
   * where the backend has a JSON mode, ask for one (Ollama `format: "json"`, OpenAI-compatible `response_format`).
   * Claude has no schema-free JSON mode, so its reply is parsed by the caller (`extractJson`).
   */
  json?: boolean;
  /** Abort the in-flight request (hook timeouts). */
  signal?: AbortSignal;
}

export interface ChatProvider { // @spec LLM-IF-001
  readonly name: string;
  readonly model: string;
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<string>;
  /** True once the backend is reachable and answering. On false, `lastError` says why. */
  ping(): Promise<boolean>;
  lastError?: string;
  /** Set (true) when `ping()` is not a probe and always answers true, so a caller can tell `ok` from "not checked" (LLM-PING-006). */
  readonly pingIsNominal?: boolean;
}
export interface Embedder { // @spec LLM-IF-001
  embed(text: string): Promise<number[]>;
}

/** Lines that mean "the model started writing the next transcript entry": stop there. */
export const TRANSCRIPT_STOPS: string[] = TRANSCRIPT_TAGS.map((tag) => `\n${tag}`); // @spec LLM-STOP-006, LLM-STOP-007
/** Blank line ends a spoken reply. Exactly four entries: OpenAI-style APIs reject more than four stops. */
const REPLY_STOPS = ["\n\n", ...TRANSCRIPT_STOPS]; // @spec LLM-STOP-005

/** Default request timeout when `llm.timeout_ms` is absent (CFG-SCH-013 default). */
const DEFAULT_TIMEOUT_MS = 60_000;
/** `llm.timeout_ms`, read defensively so this package does not depend on the config schema's merge order. */
function timeoutMs(cfg: Config["llm"]): number { // @spec LLM-CHAT-008
  const ms = (cfg as { timeout_ms?: unknown }).timeout_ms;
  return typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_TIMEOUT_MS;
}
/** The caller's signal when it passed one (it wins), otherwise the default timeout. */
const requestSignal = (cfg: Config["llm"], caller?: AbortSignal): AbortSignal => caller ?? AbortSignal.timeout(timeoutMs(cfg)); // @spec LLM-CHAT-008

export function createChatProvider(cfg: Config["llm"]): ChatProvider { // @spec LLM-IF-002, LLM-IF-003
  switch (cfg.provider) {
    case "ollama": return new Ollama(cfg);
    case "openai": return new OpenAICompatible(cfg);
    case "anthropic": return new AnthropicProvider(cfg);
    case "bedrock": return new BedrockProvider(cfg);
    case "mock": return new MockProvider(cfg);
  }
}

/** Embeddings are local Ollama (see header), except the offline hash embedder under the mock provider. */
export function createEmbedder(cfg: Config["llm"]): Embedder { // @spec LLM-EMBED-003
  if (cfg.provider === "mock") return new HashEmbedder();
  return new Ollama(cfg);
}

// ---------------------------------------------------------------------------

/** Minimal Ollama client. Also the embedder for every configuration. */
export class Ollama implements ChatProvider, Embedder {
  readonly name = "ollama";
  readonly model: string;
  lastError?: string;
  constructor(private cfg: Config["llm"], private base = urls.ollama()) { this.model = cfg.model; }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> { // @spec LLM-CHAT-001, LLM-CHAT-004, LLM-CHAT-006
    const res = await fetch(`${this.base}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.cfg.model,
        messages,
        stream: false,
        keep_alive: "24h",
        ...(opts.json ? { format: "json" } : {}), // @spec LLM-CHAT-010
        options: {
          temperature: opts.temperature ?? this.cfg.temperature,
          num_ctx: this.cfg.num_ctx,
          num_predict: opts.maxTokens ?? this.cfg.max_tokens,
          ...(opts.json ? {} : { stop: REPLY_STOPS }), // @spec LLM-STOP-001, LLM-STOP-003
        },
      }),
      signal: requestSignal(this.cfg, opts.signal), // @spec LLM-CHAT-008
    });
    if (!res.ok) throw new Error(`ollama chat ${res.status}: ${await res.text()}`); // @spec LLM-CHAT-005
    const json = (await res.json()) as { message?: { content?: string } };
    return (json.message?.content ?? "").trim(); // @spec LLM-CHAT-007, LLM-IF-004
  }

  async embed(text: string): Promise<number[]> { // @spec LLM-EMBED-001, LLM-EMBED-002
    const res = await fetch(`${this.base}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.cfg.embed_model, input: text, keep_alive: "24h" }),
      signal: requestSignal(this.cfg), // @spec LLM-CHAT-008
    });
    if (!res.ok) throw new Error(`ollama embed ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { embeddings?: number[][] };
    const v = json.embeddings?.[0];
    if (!v) throw new Error("ollama embed returned no vector");
    return v;
  }

  async ping(): Promise<boolean> { // @spec LLM-PING-001, LLM-PING-005
    try {
      const r = await fetch(`${this.base}/api/tags`, { signal: requestSignal(this.cfg) }); // @spec LLM-CHAT-008
      this.lastError = r.ok ? undefined : `ollama ${r.status} at ${this.base}`;
      return r.ok;
    } catch (err) { this.lastError = `cannot reach ollama at ${this.base}: ${String(err)}`; return false; }
  }
}

// ---------------------------------------------------------------------------

/**
 * Any server that speaks POST /v1/chat/completions. Point `base_url` at a
 * vLLM / TGI / llama.cpp box you rent by the hour, or at a hosted router.
 */
export class OpenAICompatible implements ChatProvider {
  readonly name = "openai";
  readonly model: string;
  lastError?: string;
  private base: string;
  constructor(private cfg: Config["llm"]) {
    this.model = cfg.model;
    this.base = cfg.openai.base_url.replace(/\/+$/, "");
  }

  private headers(): Record<string, string> { // @spec LLM-CHAT-003
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.cfg.openai.api_key) h.authorization = `Bearer ${this.cfg.openai.api_key}`;
    return h;
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> { // @spec LLM-CHAT-002, LLM-CHAT-004, LLM-CHAT-006
    const res = await fetch(`${this.base}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        model: this.cfg.model,
        messages,
        stream: false,
        temperature: opts.temperature ?? this.cfg.temperature,
        max_tokens: opts.maxTokens ?? this.cfg.max_tokens,
        ...(opts.json ? { response_format: { type: "json_object" } } : { stop: REPLY_STOPS }), // @spec LLM-STOP-002, LLM-STOP-003, LLM-CHAT-010
      }),
      signal: requestSignal(this.cfg, opts.signal), // @spec LLM-CHAT-008
    });
    if (!res.ok) throw new Error(`${this.name} chat ${res.status}: ${await res.text()}`); // @spec LLM-CHAT-005
    const json = (await res.json()) as { choices?: { message?: { content?: string | null } }[] };
    return (json.choices?.[0]?.message?.content ?? "").trim(); // @spec LLM-CHAT-007, LLM-IF-004
  }

  async ping(): Promise<boolean> { // @spec LLM-PING-002, LLM-PING-005
    try {
      const r = await fetch(`${this.base}/models`, { headers: this.headers(), signal: requestSignal(this.cfg) }); // @spec LLM-CHAT-008
      this.lastError = r.ok ? undefined : `${this.base}/models answered ${r.status}${r.status === 401 || r.status === 403 ? " (check llm.openai.api_key)" : ""}`;
      return r.ok;
    } catch (err) { this.lastError = `cannot reach ${this.base}: ${String(err)}`; return false; }
  }
}

// ---------------------------------------------------------------------------

/**
 * Claude. Shared by the Claude API and Bedrock paths; only the client and the
 * fallback option differ. Thinking is always on for current Claude models and
 * `max_tokens` caps thinking + text together, so a call that names no budget
 * gets `llm.claude.max_tokens` (roomier than the Ollama/OpenAI cap) and effort
 * stays low — the prompt asks for one line. A call that names a budget gets it.
 */
/** The smallest `max_tokens` the Claude API accepts. */
const CLAUDE_MIN_MAX_TOKENS = 1;

abstract class ClaudeBase implements ChatProvider {
  abstract readonly name: string;
  readonly model: string;
  lastError?: string;
  protected abstract client: Anthropic | AnthropicBedrockMantle;
  protected abstract serverFallbacks: boolean;

  constructor(protected cfg: Config["llm"]) { this.model = cfg.model; }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n"); // @spec LLM-CLAUDE-001
    const turns: Anthropic.MessageParam[] = messages
      .filter((m): m is ChatMessage & { role: "user" | "assistant" } => m.role !== "system")
      .map((m) => ({ role: m.role, content: m.content }));
    if (turns.length === 0 || turns[0]!.role !== "user") turns.unshift({ role: "user", content: "(begin)" }); // @spec LLM-CLAUDE-002

    // The caller's budget is honoured (thinking shares it; hooks run at low effort), down to the API's minimum of 1.
    const maxTokens = opts.maxTokens === undefined ? this.cfg.claude.max_tokens : Math.max(CLAUDE_MIN_MAX_TOKENS, Math.floor(opts.maxTokens)); // @spec LLM-CLAUDE-003
    const res = await this.client.beta.messages.create({
      model: this.cfg.model,
      max_tokens: maxTokens,
      system: system || undefined,
      messages: turns,
      output_config: { effort: this.cfg.claude.effort }, // @spec LLM-CLAUDE-004
      ...(opts.json ? {} : { stop_sequences: TRANSCRIPT_STOPS }), // @spec LLM-STOP-003, LLM-STOP-004
      // Safety classifiers can decline; server-side fallback re-runs on another Claude model
      // in the same call. Not offered on Bedrock, where a refusal just means "say nothing".
      ...(this.serverFallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}), // @spec LLM-CLAUDE-007
    }, opts.signal ? { signal: opts.signal } : { timeout: timeoutMs(this.cfg) }); // @spec LLM-CLAUDE-010, LLM-CHAT-006, LLM-CHAT-008
    if (res.stop_reason === "refusal") return ""; // @spec LLM-CLAUDE-006
    return res.content // @spec LLM-CLAUDE-005, LLM-IF-004
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
  }

  abstract ping(): Promise<boolean>;
}

export class AnthropicProvider extends ClaudeBase {
  readonly name = "anthropic";
  protected client: Anthropic;
  protected serverFallbacks: boolean;
  constructor(cfg: Config["llm"]) {
    super(cfg);
    // Falls back to ANTHROPIC_API_KEY / an `ant auth login` profile when no key is configured.
    this.client = new Anthropic(cfg.claude.api_key ? { apiKey: cfg.claude.api_key } : {}); // @spec LLM-CLAUDE-009
    this.serverFallbacks = cfg.claude.fallbacks;
  }
  async ping(): Promise<boolean> { // @spec LLM-PING-003, LLM-PING-005
    try {
      await this.client.models.retrieve(this.cfg.model, undefined, { timeout: timeoutMs(this.cfg) }); // @spec LLM-CHAT-008
      this.lastError = undefined;
      return true;
    } catch (err) {
      const status = (err as { status?: number }).status;
      this.lastError = status === 401 || status === 403 ? `Claude API rejected the credentials (${status}): check ANTHROPIC_API_KEY`
        : status === 404 ? `Claude API has no model "${this.cfg.model}": check llm.model`
        : String(err);
      return false;
    }
  }
}

export class BedrockProvider extends ClaudeBase {
  readonly name = "bedrock";
  protected client: AnthropicBedrockMantle;
  protected serverFallbacks = false; // @spec LLM-CLAUDE-008
  constructor(cfg: Config["llm"]) {
    super(cfg);
    // AWS credentials come from the usual places: env vars, profile, instance role.
    this.client = new AnthropicBedrockMantle(cfg.bedrock.region ? { awsRegion: cfg.bedrock.region } : {}); // @spec LLM-CLAUDE-009
  }
  readonly pingIsNominal = true; // @spec LLM-PING-006
  async ping(): Promise<boolean> { return true; } // @spec LLM-PING-004 (no cheap probe on Bedrock; errors surface on first chat)
}
