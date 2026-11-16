/**
 * Model backends. The regions never know which one is behind `chat()`, so a
 * stronger model is a config change, not a code change:
 *
 *   ollama     local GPU (default)
 *   openai     any OpenAI-compatible endpoint: vLLM on a rented GPU box,
 *              OpenRouter, Groq, Together, Fireworks ...
 *   anthropic  Claude via the Claude API
 *   bedrock    Claude via Amazon Bedrock (region and AWS keys from config)
 *   mock       deterministic offline replies, for isolated runs (never a default)
 *
 * Embedders (`Ollama`, `HashEmbedder`) are exported here but never follow the chat
 * provider: memory picks its own with `brain.memory.embedder`, so switching the
 * chat model never changes the vector size of the memory table.
 */
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";
import { createLogger, urls, type Config, type Logger } from "@cohost/config";
import { TRANSCRIPT_TAGS } from "@cohost/working-memory";
import { MockProvider, HashEmbedder } from "./mock.js";
export type { Config };
export { MockProvider, HashEmbedder };

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
  /** Base64 images for a vision model; only the Ollama provider sends them with the message (LLM-VIS-001); the others drop them (LLM-VIS-002, LLM-VIS-003). */
  images?: string[];
}
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

/** The caller's signal when it passed one (it wins), otherwise `llm.timeout_ms` (CFG-SCH-013). */
const requestSignal = (cfg: Config["llm"], caller?: AbortSignal): AbortSignal => caller ?? AbortSignal.timeout(cfg.timeout_ms); // @spec LLM-CHAT-008

/** The one logger method a provider uses. */
export type ProviderLog = Pick<Logger, "warn">;

/**
 * Removes `images` from messages for a provider that cannot send them, and warns the first time it does so (one warning per
 * provider instance, not per call).
 */
// @spec LLM-VIS-003
class ImageDropper {
  private warned = false;
  constructor(private provider: string, private log?: ProviderLog) {}
  strip(messages: ChatMessage[]): ChatMessage[] {
    if (!messages.some((m) => m.images?.length)) return messages;
    if (!this.warned) {
      this.warned = true;
      (this.log ??= createLogger("llm")).warn({ provider: this.provider }, "this provider does not support images; images on messages are dropped");
    }
    return messages.map(({ images: _images, ...rest }) => rest);
  }
}

export function createChatProvider(cfg: Config["llm"], log?: ProviderLog): ChatProvider { // @spec LLM-IF-002, LLM-IF-003
  switch (cfg.provider) {
    case "ollama": return new Ollama(cfg);
    case "openai": return new OpenAICompatible(cfg, log);
    case "anthropic": return new AnthropicProvider(cfg, log);
    case "bedrock": return new BedrockProvider(cfg, log);
    case "mock": return new MockProvider(cfg);
  }
}

// ---------------------------------------------------------------------------

/** Minimal Ollama client. Also the embedder memory uses unless `brain.memory.embedder` is `hash`. */
export class Ollama implements ChatProvider, Embedder {
  readonly name = "ollama";
  readonly model: string;
  lastError?: string;
  constructor(private cfg: Config["llm"], private base = urls.ollama()) { this.model = cfg.model; }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> { // @spec LLM-CHAT-001, LLM-CHAT-004, LLM-CHAT-006, LLM-VIS-001
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
  private images: ImageDropper;
  constructor(private cfg: Config["llm"], log?: ProviderLog) {
    this.model = cfg.model;
    this.base = cfg.openai.base_url.replace(/\/+$/, "");
    this.images = new ImageDropper(this.name, log);
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
        messages: this.images.strip(messages), // @spec LLM-VIS-002, LLM-VIS-003
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
/** Retries the SDK makes of a failed Claude request (the SDK's own default, stated so the spec pins it). */
const CLAUDE_MAX_RETRIES = 2;

/** What a test may replace in a Claude provider: the SDK's `fetch`, so a request is recorded and served locally instead of leaving the process. */
export interface ClaudeDeps { fetch?: typeof fetch }

abstract class ClaudeBase implements ChatProvider {
  abstract readonly name: string;
  readonly model: string;
  lastError?: string;
  /** Absent while the provider is not configured (LLM-CLAUDE-017, LLM-CLAUDE-018). */
  protected abstract client: Anthropic | AnthropicBedrockMantle | undefined;
  /** The error `chat()` rejects with while there is no client. */
  protected abstract notConfigured(): string;
  protected abstract serverFallbacks: boolean;

  private images: ImageDropper;

  constructor(protected cfg: Config["llm"], provider: string, log?: ProviderLog) {
    this.model = cfg.model;
    this.images = new ImageDropper(provider, log);
  }

  async chat(allMessages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
    const client = this.client;
    if (!client) throw new Error(this.notConfigured()); // @spec LLM-CLAUDE-017, LLM-CLAUDE-018
    const messages = this.images.strip(allMessages); // @spec LLM-VIS-003 (Claude has no image path here: images are dropped)
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n"); // @spec LLM-CLAUDE-001
    const turns: Anthropic.MessageParam[] = messages
      .filter((m): m is ChatMessage & { role: "user" | "assistant" } => m.role !== "system")
      .map((m) => ({ role: m.role, content: m.content }));
    if (turns.length === 0 || turns[0]!.role !== "user") turns.unshift({ role: "user", content: "(begin)" }); // @spec LLM-CLAUDE-002

    // The caller's budget is honoured (thinking shares it; hooks run at low effort), down to the API's minimum of 1.
    const maxTokens = opts.maxTokens === undefined ? this.cfg.claude.max_tokens : Math.max(CLAUDE_MIN_MAX_TOKENS, Math.floor(opts.maxTokens)); // @spec LLM-CLAUDE-003
    const res = await client.beta.messages.create({
      model: this.cfg.model,
      max_tokens: maxTokens,
      system: system || undefined,
      messages: turns,
      output_config: { effort: this.cfg.claude.effort }, // @spec LLM-CLAUDE-004
      ...(opts.json ? {} : { stop_sequences: TRANSCRIPT_STOPS }), // @spec LLM-STOP-003, LLM-STOP-004
      // Safety classifiers can decline; server-side fallback re-runs on another Claude model
      // in the same call. Not offered on Bedrock, where a refusal just means "say nothing".
      ...(this.serverFallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}), // @spec LLM-CLAUDE-007
    }, opts.signal ? { signal: opts.signal } : { timeout: this.cfg.timeout_ms }); // @spec LLM-CLAUDE-010, LLM-CHAT-006, LLM-CHAT-008
    if (res.stop_reason === "refusal") return ""; // @spec LLM-CLAUDE-006
    return res.content // @spec LLM-CLAUDE-005, LLM-IF-004
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
  }

  abstract ping(): Promise<boolean>;
}

/**
 * Runs `build` (a synchronous client construction) with every `ANTHROPIC_*` and `AWS_*` variable removed from the process
 * environment, then restores them. Both SDKs read their credential, endpoint, header, region, logging and tracing variables
 * from the environment, and all of those reads happen while the client is constructed (the default credential chain runs only
 * when no explicit credential is given, which these constructions always give). Masking by prefix rather than by name keeps a
 * variable a later SDK version adds under either prefix out of reach too (LLM-CLAUDE-019). No `await` runs while masked.
 */
function withoutSdkEnv<T>(build: () => T): T {
  const held: [string, string][] = [];
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && /^(ANTHROPIC|AWS)_/i.test(k)) { held.push([k, v]); delete process.env[k]; }
  }
  try { return build(); } finally { for (const [k, v] of held) process.env[k] = v; }
}

/**
 * The `fetch` a Claude client sends through: the last step before the network. The client is constructed with the environment
 * masked, so no header arrives from it; this wrapper is the second, request-time layer. It forces the credential headers to
 * what the configuration holds and fails the request when the client produced anything else (LLM-CLAUDE-019).
 */
function pinnedFetch(base: typeof fetch | undefined, credential: (headers: Headers) => void): typeof fetch {
  const send = base ?? globalThis.fetch;
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    credential(headers);
    return send(input, { ...init, headers });
  }) as typeof fetch;
}

/** The Claude API's own endpoint: the SDK would otherwise take `ANTHROPIC_BASE_URL` (LLM-CLAUDE-009). */
const CLAUDE_API_BASE_URL = "https://api.anthropic.com";

// @spec LLM-CLAUDE-009, LLM-CLAUDE-017
export class AnthropicProvider extends ClaudeBase {
  readonly name = "anthropic";
  protected client: Anthropic | undefined;
  protected serverFallbacks: boolean;
  constructor(cfg: Config["llm"], log?: ProviderLog, deps: ClaudeDeps = {}) {
    super(cfg, "anthropic", log);
    // Credential, endpoint and headers come from config alone (LLM-CLAUDE-019). Construction runs with every ANTHROPIC_* and AWS_*
    // variable masked, which stops the SDK reading ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL, ANTHROPIC_PROFILE,
    // ANTHROPIC_CUSTOM_HEADERS and the rest; the explicit `apiKey`, `baseURL` and `authToken: null` are then the only sources. The
    // fetch wrapper pins the credential at request time. With no key there is no client, so nothing can be looked up.
    const apiKey = cfg.claude.api_key;
    this.client = apiKey
      ? withoutSdkEnv(() => new Anthropic({
          apiKey, authToken: null, baseURL: CLAUDE_API_BASE_URL,
          maxRetries: CLAUDE_MAX_RETRIES,
          fetch: pinnedFetch(deps.fetch, (h) => { h.set("authorization", `Bearer ${apiKey}`); h.delete("x-api-key"); h.delete("proxy-authorization"); }),
        })) // @spec LLM-CLAUDE-014
      : undefined;
    this.serverFallbacks = cfg.claude.fallbacks;
  }
  protected notConfigured(): string { return "the anthropic provider is not configured: llm.claude.api_key is not set"; }
  async ping(): Promise<boolean> { // @spec LLM-PING-003, LLM-PING-005
    if (!this.client) { this.lastError = this.notConfigured(); return false; } // @spec LLM-CLAUDE-017
    try {
      await this.client.models.retrieve(this.cfg.model, undefined, { timeout: this.cfg.timeout_ms }); // @spec LLM-CHAT-008
      this.lastError = undefined;
      return true;
    } catch (err) {
      const status = (err as { status?: number }).status;
      this.lastError = status === 401 || status === 403 ? `Claude API rejected the credentials (${status}): check llm.claude.api_key`
        : status === 404 ? `Claude API has no model "${this.cfg.model}": check llm.model`
        : String(err);
      return false;
    }
  }
}

// @spec LLM-CLAUDE-015, LLM-CLAUDE-016, LLM-CLAUDE-018
export class BedrockProvider extends ClaudeBase {
  readonly name = "bedrock";
  protected client: AnthropicBedrockMantle | undefined;
  protected serverFallbacks = false; // @spec LLM-CLAUDE-008
  constructor(cfg: Config["llm"], log?: ProviderLog, deps: ClaudeDeps = {}) {
    super(cfg, "bedrock", log);
    const { region, access_key_id: accessKey, secret_access_key: secretKey } = cfg.bedrock;
    if (!!accessKey !== !!secretKey) {
      throw new Error("llm.bedrock.access_key_id and llm.bedrock.secret_access_key must be set together: only one of them is set"); // @spec LLM-CLAUDE-016
    }
    // Region, keys and endpoint are explicit, with no session token, and construction runs with every ANTHROPIC_* and AWS_*
    // variable masked, so the SDK reads none of AWS_REGION, AWS_DEFAULT_REGION, AWS_BEARER_TOKEN_BEDROCK,
    // ANTHROPIC_BEDROCK_MANTLE_BASE_URL, ANTHROPIC_CUSTOM_HEADERS, AWS_SESSION_TOKEN, AWS_PROFILE and never reaches its default
    // credential chain (it takes that only when no explicit key pair is given). The fetch wrapper refuses a request that is not
    // signed with the configured access key. With anything empty there is no client (LLM-CLAUDE-019).
    this.client = region && accessKey && secretKey
      ? withoutSdkEnv(() => new AnthropicBedrockMantle({
          awsRegion: region, awsAccessKey: accessKey, awsSecretAccessKey: secretKey, awsSessionToken: null, apiKey: null,
          baseURL: `https://bedrock-mantle.${region}.api.aws/anthropic`,
          maxRetries: CLAUDE_MAX_RETRIES,
          fetch: pinnedFetch(deps.fetch, (h) => {
            if (!(h.get("authorization") ?? "").startsWith(`AWS4-HMAC-SHA256 Credential=${accessKey}/`)) {
              throw new Error("bedrock request is not signed with llm.bedrock.access_key_id; refusing to send it");
            }
            h.delete("x-api-key"); h.delete("x-amz-security-token");
          }),
        })) // @spec LLM-CLAUDE-014
      : undefined;
  }
  protected notConfigured(): string {
    const { region, access_key_id: a, secret_access_key: k } = this.cfg.bedrock;
    const empty = [["region", region], ["access_key_id", a], ["secret_access_key", k]].filter(([, v]) => !v).map(([n]) => `llm.bedrock.${n}`);
    return `the bedrock provider is not configured: ${empty.join(", ")} not set`;
  }
  readonly pingIsNominal = true; // @spec LLM-PING-006
  async ping(): Promise<boolean> { return true; } // @spec LLM-PING-004 (no cheap probe on Bedrock; errors surface on first chat)
}
