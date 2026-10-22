/**
 * Model backends. The regions never know which one is behind `chat()`, so a
 * stronger model is a config change, not a code change:
 *
 *   ollama     local GPU (default)
 *   openai     any OpenAI-compatible endpoint: vLLM on a rented GPU box,
 *              OpenRouter, Groq, Together, Fireworks ...
 *   anthropic  Claude via the Claude API
 *   bedrock    Claude via Amazon Bedrock (AWS credentials from the environment)
 *
 * Embeddings always come from Ollama: they're cheap, and switching the chat
 * model must not change the vector size of the memory table.
 */
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";
import { urls, type Config } from "@cohost/config";
export type { Config };

export interface ChatMessage { role: "system" | "user" | "assistant"; content: string }
export interface ChatOptions {
  maxTokens?: number;
  temperature?: number;
  /** JSON reply wanted: don't send stop sequences (a blank line or a transcript tag inside JSON would truncate it). */
  json?: boolean;
  /** Abort the in-flight request (hook timeouts). */
  signal?: AbortSignal;
}

export interface ChatProvider {
  readonly name: string;
  readonly model: string;
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<string>;
  /** True once the backend is reachable and answering. On false, `lastError` says why. */
  ping(): Promise<boolean>;
  lastError?: string;
}
export interface Embedder {
  embed(text: string): Promise<number[]>;
}

/** Lines that mean "the model started writing the next transcript entry": stop there. */
const TRANSCRIPT_STOPS = ["\n[chat]", "\n[voice]", "\n[screen]"];
/** Blank line ends a spoken reply. Exactly four entries: OpenAI-style APIs reject more than four stops. */
const REPLY_STOPS = ["\n\n", ...TRANSCRIPT_STOPS];

export function createChatProvider(cfg: Config["llm"]): ChatProvider {
  switch (cfg.provider) {
    case "ollama": return new Ollama(cfg);
    case "openai": return new OpenAICompatible(cfg);
    case "anthropic": return new AnthropicProvider(cfg);
    case "bedrock": return new BedrockProvider(cfg);
  }
}

/** Embeddings are always local Ollama (see header). */
export function createEmbedder(cfg: Config["llm"]): Embedder {
  return new Ollama(cfg);
}

// ---------------------------------------------------------------------------

/** Minimal Ollama client. Also the embedder for every configuration. */
export class Ollama implements ChatProvider, Embedder {
  readonly name = "ollama";
  readonly model: string;
  constructor(private cfg: Config["llm"], private base = urls.ollama()) { this.model = cfg.model; }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
    const res = await fetch(`${this.base}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.cfg.model,
        messages,
        stream: false,
        keep_alive: "24h",
        options: {
          temperature: opts.temperature ?? this.cfg.temperature,
          num_ctx: this.cfg.num_ctx,
          num_predict: opts.maxTokens ?? this.cfg.max_tokens,
          ...(opts.json ? {} : { stop: REPLY_STOPS }),
        },
      }),
      signal: opts.signal,
    });
    if (!res.ok) throw new Error(`ollama chat ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { message?: { content?: string } };
    return (json.message?.content ?? "").trim();
  }

  async embed(text: string): Promise<number[]> {
    const res = await fetch(`${this.base}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.cfg.embed_model, input: text, keep_alive: "24h" }),
    });
    if (!res.ok) throw new Error(`ollama embed ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { embeddings?: number[][] };
    const v = json.embeddings?.[0];
    if (!v) throw new Error("ollama embed returned no vector");
    return v;
  }

  lastError?: string;
  async ping(): Promise<boolean> {
    try {
      const r = await fetch(`${this.base}/api/tags`);
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
  private base: string;
  constructor(private cfg: Config["llm"]) {
    this.model = cfg.model;
    this.base = cfg.openai.base_url.replace(/\/+$/, "");
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.cfg.openai.api_key) h.authorization = `Bearer ${this.cfg.openai.api_key}`;
    return h;
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
    const res = await fetch(`${this.base}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        model: this.cfg.model,
        messages,
        stream: false,
        temperature: opts.temperature ?? this.cfg.temperature,
        max_tokens: opts.maxTokens ?? this.cfg.max_tokens,
        ...(opts.json ? {} : { stop: REPLY_STOPS }),
      }),
      signal: opts.signal,
    });
    if (!res.ok) throw new Error(`${this.name} chat ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { choices?: { message?: { content?: string | null } }[] };
    return (json.choices?.[0]?.message?.content ?? "").trim();
  }

  lastError?: string;
  async ping(): Promise<boolean> {
    try {
      const r = await fetch(`${this.base}/models`, { headers: this.headers() });
      this.lastError = r.ok ? undefined : `${this.base}/models answered ${r.status}${r.status === 401 || r.status === 403 ? " (check llm.openai.api_key)" : ""}`;
      return r.ok;
    } catch (err) { this.lastError = `cannot reach ${this.base}: ${String(err)}`; return false; }
  }
}

// ---------------------------------------------------------------------------

/**
 * Claude. Shared by the Claude API and Bedrock paths; only the client and the
 * fallback option differ. Thinking is always on for current Claude models and
 * `max_tokens` caps thinking + text together, so this path uses its own,
 * roomier `max_tokens` and keeps effort low — the prompt asks for one line.
 */
abstract class ClaudeBase implements ChatProvider {
  abstract readonly name: string;
  readonly model: string;
  protected abstract client: Anthropic | AnthropicBedrockMantle;
  protected abstract serverFallbacks: boolean;

  constructor(protected cfg: Config["llm"]) { this.model = cfg.model; }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const turns: Anthropic.MessageParam[] = messages
      .filter((m): m is ChatMessage & { role: "user" | "assistant" } => m.role !== "system")
      .map((m) => ({ role: m.role, content: m.content }));
    if (turns.length === 0 || turns[0]!.role !== "user") turns.unshift({ role: "user", content: "(begin)" });

    const maxTokens = Math.max(opts.maxTokens ?? 0, this.cfg.claude.max_tokens);
    const res = await this.client.beta.messages.create({
      model: this.cfg.model,
      max_tokens: maxTokens,
      system: system || undefined,
      messages: turns,
      output_config: { effort: this.cfg.claude.effort },
      ...(opts.json ? {} : { stop_sequences: TRANSCRIPT_STOPS }),
      // Safety classifiers can decline; server-side fallback re-runs on another Claude model
      // in the same call. Not offered on Bedrock, where a refusal just means "say nothing".
      ...(this.serverFallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
    }, { signal: opts.signal });
    if (res.stop_reason === "refusal") return "";
    return res.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
  }

  lastError?: string;
  abstract ping(): Promise<boolean>;
}

export class AnthropicProvider extends ClaudeBase {
  readonly name = "anthropic";
  protected client: Anthropic;
  protected serverFallbacks: boolean;
  constructor(cfg: Config["llm"]) {
    super(cfg);
    // Falls back to ANTHROPIC_API_KEY / an `ant auth login` profile when no key is configured.
    this.client = new Anthropic(cfg.claude.api_key ? { apiKey: cfg.claude.api_key } : {});
    this.serverFallbacks = cfg.claude.fallbacks;
  }
  async ping(): Promise<boolean> {
    try {
      await this.client.models.retrieve(this.cfg.model);
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
  protected serverFallbacks = false;
  constructor(cfg: Config["llm"]) {
    super(cfg);
    // AWS credentials come from the usual places: env vars, profile, instance role.
    this.client = new AnthropicBedrockMantle(cfg.bedrock.region ? { awsRegion: cfg.bedrock.region } : {});
  }
  async ping(): Promise<boolean> { return true; } // no cheap probe on Bedrock; errors surface on first chat
}
