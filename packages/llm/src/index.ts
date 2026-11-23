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
import { assertTextHistory } from "./history.js";
export type { Config };
export { MockProvider, HashEmbedder };

/** A tool the model may call. Offered by `complete()` and `stream()` once tool calls land (#162). */
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema, `type` "object". */
  parameters: object;
}
/** A tool call the model asked for. `arguments` is always a parsed object; `invalid` holds the raw text when it was not one. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  invalid?: string;
}
/** The closed set of messages a history may hold, by role. */
export type ChatMessage =
  | { role: "system"; content: string }
  /** Base64 images for a vision model; only the Ollama provider sends them with the message (LLM-VIS-001); the others drop them (LLM-VIS-002, LLM-VIS-003). */
  | { role: "user"; content: string; images?: string[] }
  /** `toolCalls` is present only when the model asked for tools; `continuation` is opaque to callers. */
  | { role: "assistant"; content: string; toolCalls?: ToolCall[]; continuation?: unknown }
  /** One tool's result, answering the call with `callId`. */
  | { role: "tool"; callId: string; name: string; content: string; isError?: boolean };
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
export interface ChatRequest extends ChatOptions {
  /** Offered to the model. `complete()` does not act on them yet (#162). */
  tools?: ToolSpec[];
}
/** The outcome of a non-streamed reply. */
export interface ChatResult {
  /** Trimmed; "" when the model said nothing or only asked for tools. */
  text: string;
  /** In the order the model asked. */
  toolCalls: ToolCall[];
  finish: "stop" | "length" | "tool_calls" | "refusal";
  /** The assistant message to append to the history; `toolCalls` is absent when the model asked for none. */
  message: ChatMessage & { role: "assistant" };
}
/** Streamed reply events, from `stream()`. Ollama and OpenAI-compatible stream text; `tool_call` events land with #162. */
export type ChatEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "done"; result: ChatResult };

/** Every failure a provider raises from a call that reaches the network (LLM-ERR-001). */
export class ChatError extends Error {
  constructor(
    readonly kind: "http" | "connect" | "stream" | "not_configured",
    message: string,
    readonly status?: number,
  ) { super(message); this.name = "ChatError"; }
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

/**
 * The result of a reply that asked for no tools: the trimmed text, an empty text when the backend sent none, and an assistant
 * message with no `toolCalls` key (LLM-IF-022).
 */
function textResult(content: string | null | undefined, finish: ChatResult["finish"]): ChatResult { // @spec LLM-IF-005, LLM-IF-006, LLM-IF-007, LLM-IF-022, LLM-IF-014, LLM-IF-015, LLM-CHAT-007
  const text = (content ?? "").trim();
  return { text, toolCalls: [], finish, message: { role: "assistant", content: text } };
}

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
    if (!messages.some((m) => m.role === "user" && m.images?.length)) return messages;
    if (!this.warned) {
      this.warned = true;
      (this.log ??= createLogger("llm")).warn({ provider: this.provider }, "this provider does not support images; images on messages are dropped");
    }
    return messages.map((m) => {
      if (m.role !== "user" || !m.images) return m;
      const { images: _images, ...rest } = m;
      return rest;
    });
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

/** One backend event as a provider's framing reads it. `end` is the backend closing its reply before a final event. */
type WireEvent =
  | { kind: "content"; text: string }
  | { kind: "keepalive" }
  | { kind: "final"; finish: ChatResult["finish"] }
  | { kind: "end" };

/** What a provider adds to the shared streamed-reply machinery: the request, its framing, and its single-body reading. */
interface StreamPlan {
  name: string;
  timeoutMs: number;
  /** Synchronous; a throw here is a programming error and surfaces unwrapped (LLM-IF-021). */
  request(): { url: string; init: RequestInit };
  /** One line of the framed body (blank lines included); a bad line throws `ChatError` of kind `stream`. */
  line(line: string): WireEvent[];
  /** A backend that ignored `stream:true` and answered one JSON document (LLM-STREAM-029). */
  whole(json: any): { text: string | null | undefined; finish: ChatResult["finish"] };
}

/** Holds back whitespace so no delta starts a reply with it or ends the reply with it (LLM-STREAM-009 to LLM-STREAM-011). */
class TextTrimmer { // @spec LLM-STREAM-009, LLM-STREAM-010, LLM-STREAM-011
  /** Every content piece as the backend sent it. */
  raw = "";
  private started = false;
  private held = "";
  /** The delta this piece releases, or "" when it releases none. */
  push(piece: string): string {
    this.raw += piece;
    let s = piece;
    if (!this.started) {
      s = s.trimStart();
      if (!s) return "";
      this.started = true;
    }
    const body = s.trimEnd();
    if (!body) { this.held += s; return ""; }
    const out = this.held + body;
    this.held = s.slice(body.length);
    return out;
  }
}

/** A `ChatError` of kind `stream`, or a fresh one for a malformed chunk. */
const streamError = (name: string, detail: string): ChatError => new ChatError("stream", `${name} stream: ${detail}`);

/** The non-streamed request: a failure before any reply is `connect` (LLM-ERR-008), except a caller's abort or a timeout, which pass through. */
async function sendRequest(name: string, url: string, init: RequestInit & { signal: AbortSignal }): Promise<Response> { // @spec LLM-ERR-008
  try {
    return await fetch(url, init);
  } catch (e) {
    if (init.signal.aborted) throw e;
    throw new ChatError("connect", `cannot reach ${name} at ${url}: ${String(e)}`);
  }
}

/** A `TimeoutError` as `AbortSignal.timeout` gives it (LLM-STREAM-015, LLM-STREAM-016). */
const timeoutError = (ms: number): Error => {
  const err = new Error(`no reply from the backend within llm.timeout_ms (${ms} ms)`);
  err.name = "TimeoutError";
  return err;
};

/**
 * The streamed call every streaming provider runs. Nothing runs until the first read (LLM-IF-008), and a failure of any kind
 * surfaces from that read (LLM-IF-021). Two clocks, each `timeoutMs`, run only while a read is pending (LLM-STREAM-034,
 * LLM-STREAM-035): the first-output clock from the request until the backend sends content (keepalives do not stop it,
 * LLM-STREAM-015), and the between-events clock after that, which any backend event restarts (LLM-STREAM-016). The caller's
 * signal adds a way to cancel and never replaces either clock (LLM-STREAM-018). Abort by the caller rethrows the caller's
 * reason (LLM-STREAM-026, LLM-ERR-006). Failures after the response began are `stream` (LLM-STREAM-021).
 */
async function* streamReply(plan: StreamPlan, messages: ChatMessage[], opts: ChatOptions): AsyncGenerator<ChatEvent> { // @spec LLM-IF-008, LLM-IF-009, LLM-IF-010, LLM-IF-021
  assertTextHistory(messages);
  const { url, init } = plan.request(); // @spec LLM-STREAM-001, LLM-STREAM-004, LLM-STREAM-014, LLM-STOP-012, LLM-STOP-014, LLM-STOP-018
  const caller = opts.signal;
  const ac = new AbortController();
  const onCallerAbort = () => ac.abort(caller?.reason);
  caller?.addEventListener("abort", onCallerAbort, { once: true });

  let timedOut = false;
  let responded = false;
  let sawOutput = false;
  const firstStart = Date.now();
  let mark = firstStart;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  /** Runs one pending step under the clock, and maps what it throws. */
  const clocked = async <T>(step: () => Promise<T>): Promise<T> => {
    const due = (sawOutput ? mark : firstStart) + plan.timeoutMs;
    timer = setTimeout(() => { timedOut = true; ac.abort(); }, Math.max(0, due - Date.now()));
    try {
      return await step();
    } catch (e) {
      if (timedOut) throw timeoutError(plan.timeoutMs);
      if (caller?.aborted) throw caller.reason;
      if (e instanceof ChatError) throw e;
      throw responded
        ? streamError(plan.name, `the connection failed mid-reply: ${String(e)}`)
        : new ChatError("connect", `cannot reach ${plan.name} at ${url}: ${String(e)}`);
    } finally {
      clearTimeout(timer);
    }
  };

  /** The reply's lines as they arrive; each pending read runs under the clock. */
  async function* lines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
    reader = body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await clocked(() => reader!.read());
      if (done) break;
      buf += dec.decode(value, { stream: true });
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        yield buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
      }
    }
    buf += dec.decode();
    if (buf) yield buf.replace(/\r$/, "");
  }

  try {
    const res = await clocked(() => fetch(url, { ...init, signal: ac.signal }));
    responded = true;
    mark = Date.now();
    if (!res.ok) {
      const body = await clocked(() => res.text());
      throw new ChatError("http", `${plan.name} chat ${res.status}: ${body}`, res.status); // @spec LLM-STREAM-020, LLM-ERR-004, LLM-CHAT-020
    }
    if (!res.body) throw streamError(plan.name, "the response had no body");
    const trimmer = new TextTrimmer();
    let finish: ChatResult["finish"] | undefined;

    if ((res.headers.get("content-type") ?? "").startsWith("application/json")) { // @spec LLM-STREAM-029
      const text = await clocked(() => res.text());
      let json: unknown;
      try { json = JSON.parse(text); } catch { throw streamError(plan.name, "the single JSON body is not JSON"); }
      const one = plan.whole(json);
      sawOutput = true;
      const delta = trimmer.push(one.text ?? "");
      if (delta) yield { type: "text", delta };
      finish = one.finish;
    } else {
      outer: for await (const line of lines(res.body)) { // @spec LLM-STREAM-002, LLM-STREAM-005
        for (const ev of plan.line(line)) {
          if (ev.kind === "keepalive") { mark = Date.now(); continue; }
          if (ev.kind === "end") throw streamError(plan.name, "the reply ended before its final event"); // @spec LLM-STREAM-037, LLM-STREAM-022
          sawOutput = true;
          if (ev.kind === "final") { finish = ev.finish; break outer; } // @spec LLM-STREAM-036
          const delta = trimmer.push(ev.text);
          mark = Date.now();
          if (delta) { yield { type: "text", delta }; mark = Date.now(); } // @spec LLM-STREAM-010
        }
      }
    }
    if (!finish) throw streamError(plan.name, "the reply ended before its final event"); // @spec LLM-STREAM-022
    yield { type: "done", result: textResult(trimmer.raw, finish) }; // @spec LLM-IF-009, LLM-STREAM-009, LLM-STREAM-028
  } finally {
    clearTimeout(timer);
    caller?.removeEventListener("abort", onCallerAbort);
    if (reader) reader.cancel().catch(() => {});
    if (!ac.signal.aborted) ac.abort(); // @spec LLM-IF-010
  }
}

/** Ollama's framing: one JSON object per line; `content` is text and `done: true` is the final line (LLM-STREAM-002). */
function ollamaLine(line: string): WireEvent[] {
  if (!line.trim()) return [];
  const j = parseChunk("ollama", line);
  const content = j?.message?.content;
  const evs: WireEvent[] = [typeof content === "string" && content !== "" ? { kind: "content", text: content } : { kind: "keepalive" }];
  if (j?.done) evs.push({ kind: "final", finish: j.done_reason === "length" ? "length" : "stop" });
  return evs;
}

/** OpenAI-compatible framing: SSE. `data:` chunks carry `delta.content` and the `finish_reason` chunk is final; `[DONE]` before it ends the reply without one (LLM-STREAM-004, LLM-STREAM-037). Comments and other fields are keepalives. */
function openaiLine(line: string): WireEvent[] {
  if (!line.trim()) return [];
  if (!line.startsWith("data:")) return [{ kind: "keepalive" }];
  const payload = line.slice(5).trim();
  if (payload === "[DONE]") return [{ kind: "end" }];
  const choice = parseChunk("openai", payload)?.choices?.[0];
  const content = choice?.delta?.content;
  const evs: WireEvent[] = [typeof content === "string" && content !== "" ? { kind: "content", text: content } : { kind: "keepalive" }];
  if (choice?.finish_reason) evs.push({ kind: "final", finish: choice.finish_reason === "length" ? "length" : "stop" });
  return evs;
}

function parseChunk(name: string, text: string): any {
  try { return JSON.parse(text); } catch { throw streamError(name, `a chunk is not JSON: ${text.slice(0, 80)}`); } // @spec LLM-STREAM-023
}

/** Minimal Ollama client. Also the embedder memory uses unless `brain.memory.embedder` is `hash`. */
export class Ollama implements ChatProvider, Embedder {
  readonly name = "ollama";
  readonly model: string;
  lastError?: string;
  constructor(private cfg: Config["llm"], private base = urls.ollama()) { this.model = cfg.model; }

  /** The `/api/chat` body that `chat()`, `complete()` and `stream()` send; `streaming` sets `stream` (LLM-STREAM-001). */
  private body(messages: ChatMessage[], opts: ChatRequest, streaming: boolean): string { // @spec LLM-CHAT-001, LLM-CHAT-004, LLM-CHAT-006, LLM-VIS-001, LLM-CHAT-011, LLM-CHAT-015, LLM-CHAT-019, LLM-CHAT-021, LLM-STOP-011, LLM-CHAT-016, LLM-CHAT-022
    return JSON.stringify({
      model: this.cfg.model,
      messages,
      stream: streaming,
      keep_alive: "24h",
      ...(opts.json ? { format: "json" } : {}), // @spec LLM-CHAT-010
      options: {
        temperature: opts.temperature ?? this.cfg.temperature,
        num_ctx: this.cfg.num_ctx,
        num_predict: opts.maxTokens ?? this.cfg.max_tokens,
        ...(opts.json ? {} : { stop: REPLY_STOPS }), // @spec LLM-STOP-001, LLM-STOP-003, LLM-STOP-012
      },
    });
  }

  /** The one non-streamed `/api/chat` request that `chat()` and `complete()` both send. */
  private async send(messages: ChatMessage[], opts: ChatRequest): Promise<{ message?: { content?: string | null }; done_reason?: string }> { // @spec LLM-CHAT-001
    const res = await sendRequest(this.name, `${this.base}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: this.body(messages, opts, false),
      signal: requestSignal(this.cfg, opts.signal), // @spec LLM-CHAT-008
    });
    if (!res.ok) throw new ChatError("http", `ollama chat ${res.status}: ${await res.text()}`, res.status); // @spec LLM-CHAT-005, LLM-ERR-007
    return (await res.json()) as { message?: { content?: string | null }; done_reason?: string };
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> { // @spec LLM-IF-011, LLM-IF-004
    assertTextHistory(messages);
    return (await this.complete(messages, opts)).text;
  }

  async complete(messages: ChatMessage[], req: ChatRequest = {}): Promise<ChatResult> { // @spec LLM-IF-005, LLM-IF-014, LLM-IF-015
    const json = await this.send(messages, req);
    return textResult(json.message?.content, json.done_reason === "length" ? "length" : "stop");
  }

  /** A streamed reply (LLM-IF-008): nothing is sent until the first read. */
  stream(messages: ChatMessage[], opts: ChatOptions = {}): AsyncGenerator<ChatEvent> { // @spec LLM-IF-008, LLM-STREAM-001, LLM-STREAM-002
    return streamReply({
      name: this.name,
      timeoutMs: this.cfg.timeout_ms,
      request: () => ({
        url: `${this.base}/api/chat`,
        init: { method: "POST", headers: { "content-type": "application/json" }, body: this.body(messages, opts, true) },
      }),
      line: ollamaLine,
      whole: (j) => ({ text: j?.message?.content, finish: j?.done_reason === "length" ? "length" : "stop" }),
    }, messages, opts);
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

  /** The `/chat/completions` body that `chat()`, `complete()` and `stream()` send; `streaming` sets `stream` (LLM-STREAM-004). */
  private body(messages: ChatMessage[], opts: ChatRequest, streaming: boolean): string { // @spec LLM-CHAT-002, LLM-CHAT-004, LLM-CHAT-006, LLM-CHAT-012, LLM-CHAT-013, LLM-CHAT-015, LLM-CHAT-019, LLM-CHAT-021, LLM-STOP-013, LLM-CHAT-022, LLM-CHAT-016
    return JSON.stringify({
      model: this.cfg.model,
      messages: this.images.strip(messages), // @spec LLM-VIS-002, LLM-VIS-003
      stream: streaming,
      temperature: opts.temperature ?? this.cfg.temperature,
      max_tokens: opts.maxTokens ?? this.cfg.max_tokens,
      ...(opts.json ? { response_format: { type: "json_object" } } : { stop: REPLY_STOPS }), // @spec LLM-STOP-002, LLM-STOP-003, LLM-CHAT-010, LLM-STOP-014, LLM-STOP-018
    });
  }

  /** The one non-streamed `/chat/completions` request that `chat()` and `complete()` both send. */
  private async send(messages: ChatMessage[], opts: ChatRequest): Promise<{ choices?: { message?: { content?: string | null }; finish_reason?: string | null }[] }> { // @spec LLM-CHAT-002
    const res = await sendRequest(this.name, `${this.base}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: this.body(messages, opts, false),
      signal: requestSignal(this.cfg, opts.signal), // @spec LLM-CHAT-008
    });
    if (!res.ok) throw new ChatError("http", `${this.name} chat ${res.status}: ${await res.text()}`, res.status); // @spec LLM-CHAT-005, LLM-ERR-007
    return (await res.json()) as { choices?: { message?: { content?: string | null }; finish_reason?: string | null }[] };
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> { // @spec LLM-IF-011, LLM-IF-004
    assertTextHistory(messages);
    return (await this.complete(messages, opts)).text;
  }

  async complete(messages: ChatMessage[], req: ChatRequest = {}): Promise<ChatResult> { // @spec LLM-IF-005, LLM-IF-014, LLM-IF-015
    const json = await this.send(messages, req);
    const choice = json.choices?.[0];
    return textResult(choice?.message?.content, choice?.finish_reason === "length" ? "length" : "stop");
  }

  /** A streamed reply (LLM-IF-008): nothing is sent until the first read. */
  stream(messages: ChatMessage[], opts: ChatOptions = {}): AsyncGenerator<ChatEvent> { // @spec LLM-IF-008, LLM-STREAM-004, LLM-STREAM-005, LLM-CHAT-014
    return streamReply({
      name: this.name,
      timeoutMs: this.cfg.timeout_ms,
      request: () => ({
        url: `${this.base}/chat/completions`,
        init: { method: "POST", headers: this.headers(), body: this.body(messages, opts, true) },
      }),
      line: openaiLine,
      whole: (j) => ({ text: j?.choices?.[0]?.message?.content, finish: j?.choices?.[0]?.finish_reason === "length" ? "length" : "stop" }),
    }, messages, opts);
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

  async chat(allMessages: ChatMessage[], opts: ChatOptions = {}): Promise<string> { // @spec LLM-IF-011, LLM-IF-012
    assertTextHistory(allMessages);
    const client = this.client;
    if (!client) throw new Error(this.notConfigured()); // @spec LLM-CLAUDE-017, LLM-CLAUDE-018
    const messages = this.images.strip(allMessages); // @spec LLM-VIS-003 (Claude has no image path here: images are dropped)
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n"); // @spec LLM-CLAUDE-001
    const turns: Anthropic.MessageParam[] = messages
      .filter((m): m is Extract<ChatMessage, { role: "user" | "assistant" }> => m.role === "user" || m.role === "assistant")
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
