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
import { urls, type Config } from "@cohost/config";
import { TRANSCRIPT_TAGS } from "@cohost/working-memory";
import { MockProvider, HashEmbedder } from "./mock.js";
import { assertTextHistory } from "./history.js";
import { checkRequest } from "./request.js";
export type { Config };
export { MockProvider, HashEmbedder };

/** A tool the model may call. Offered by `complete()` and `stream()`; `chat()` offers none. */
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
  /** Bare base64 images for a vision model, each sent in its vendor's form; the media type is sniffed from the bytes (LLM-VIS-001..005). */
  | { role: "user"; content: string; images?: string[] }
  /** `toolCalls` is present only when the model asked for tools; `continuation` is opaque to callers and is read only by the provider named in its `name` (LLM-TOOL-014, LLM-TOOL-015). */
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
  /** Offered to the model by `complete()` and `stream()`; with `json: true` it is a `TypeError` (LLM-TOOL-002). */
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
/** Streamed reply events, from `stream()`: text as it arrives, then the calls once the reply's end is known, then `done`. */
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

export interface ChatProvider { // @spec LLM-IF-001, LLM-IF-020
  readonly name: string;
  readonly model: string;
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<string>;
  /** A non-streamed reply: text, tool calls, finish reason and the assistant message (LLM-IF-005). */
  complete(messages: ChatMessage[], req?: ChatRequest): Promise<ChatResult>;
  /** A streamed reply: text as it arrives, the calls, then `done` (LLM-IF-008). Nothing is sent before the first read. */
  stream(messages: ChatMessage[], opts?: ChatRequest): AsyncGenerator<ChatEvent>;
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
 * The media types a vision input may carry. Images are sent as bare base64; the type is read from the decoded leading bytes, since
 * no caller names it (LLM-VIS-004).
 */
type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/; // standard alphabet, padded; checked with a length rule, so the match stays linear on large images
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * The media type of one base64 image, from its first 12 decoded bytes (enough for WebP's `RIFF....WEBP`). Data that is not base64, or
 * is none of JPEG, PNG, GIF or WebP, is a caller's programming error: a `TypeError`, raised before any request (LLM-VIS-005).
 */
function sniffImage(data: string): ImageMediaType { // @spec LLM-VIS-004, LLM-VIS-005
  if (data.length % 4 !== 0 || !BASE64.test(data)) throw new TypeError("image data is not base64");
  const head = Buffer.from(data.slice(0, 16), "base64");
  const at = (offset: number, text: string): boolean => head.subarray(offset, offset + text.length).toString("latin1") === text;
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return "image/png";
  if (at(0, "GIF8")) return "image/gif";
  if (at(0, "RIFF") && at(8, "WEBP")) return "image/webp";
  throw new TypeError("image data is not JPEG, PNG, GIF or WebP");
}

export function createChatProvider(cfg: Config["llm"]): ChatProvider { // @spec LLM-IF-002, LLM-IF-003
  switch (cfg.provider) {
    case "ollama": return new Ollama(cfg);
    case "openai": return new OpenAICompatible(cfg);
    case "anthropic": return new AnthropicProvider(cfg);
    case "bedrock": return new BedrockProvider(cfg);
    case "mock": return new MockProvider(cfg);
  }
}

// ---- tool rules shared by the providers that carry tools (#162)

/** Whether a request offers tools; `tools: []` offers none (LLM-TOOL-026). */
const hasTools = (req: ChatRequest): boolean => (req.tools?.length ?? 0) > 0;

/** The `tools` a request sends, as `{type: "function", function}` (LLM-TOOL-003, LLM-TOOL-006); undefined is left out of the body. */
function wireTools(req: ChatRequest): object[] | undefined { // @spec LLM-TOOL-003, LLM-TOOL-006, LLM-TOOL-026
  return hasTools(req)
    ? req.tools!.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }))
    : undefined;
}

/** The stop list a request sends: none for a JSON reply or a reply that offers tools (LLM-STOP-008, LLM-STOP-009, LLM-STOP-019). */
const stopsFor = (req: ChatRequest): string[] | undefined => (req.json || hasTools(req) ? undefined : REPLY_STOPS); // @spec LLM-STOP-008, LLM-STOP-009, LLM-STOP-019

/**
 * The arguments a backend sent, as an object (LLM-TOOL-016, LLM-TOOL-029). A string is parsed; a blank string is `{}`; anything
 * that is not a JSON object is `{}` with `invalid` holding the raw text.
 */
function parseArguments(raw: unknown): { arguments: Record<string, unknown>; invalid?: string } { // @spec LLM-TOOL-016, LLM-TOOL-029
  if (raw === undefined) return { arguments: {} };
  if (typeof raw === "string") {
    if (raw.trim() === "") return { arguments: {} };
    try { return asObject(JSON.parse(raw)) ?? { arguments: {}, invalid: raw }; } catch { return { arguments: {}, invalid: raw }; }
  }
  return asObject(raw) ?? { arguments: {}, invalid: JSON.stringify(raw) };
}
const asObject = (v: unknown): { arguments: Record<string, unknown> } | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? { arguments: v as Record<string, unknown> } : undefined;

/** Arguments that begin but never finish as JSON: what the token cap leaves of a call it cut off (LLM-TOOL-022). */
function cutOff(raw: unknown): boolean {
  if (typeof raw !== "string" || raw.trim() === "") return false;
  try { JSON.parse(raw); return false; } catch { return true; }
}

/** A tool call as a backend sent it: whole (Ollama, or a single JSON body), or one fragment of the call at `index` (OpenAI streams). */
/** `fragment` marks a piece of a streamed call (OpenAI deltas), which may continue the last call when it has no index or id. */
interface WireCall { index?: number; id?: string; name?: string; args?: unknown; fragment?: boolean }

/**
 * Collects a reply's calls and builds them in the order the model asked (LLM-TOOL-024). Fragments of one call join by `index`
 * (LLM-TOOL-007). A fragment with no index joins the call that has its id; a fragment with neither index nor id continues the
 * last call; any other unindexed call takes the next free position. A call the cap cut off (`capped`, and `dropCut` for backends
 * whose cap can cut arguments) is dropped (LLM-TOOL-022). A call with no backend id gets `call_<position>`, unique within the reply.
 */
class CallAssembler { // @spec LLM-TOOL-004, LLM-TOOL-007, LLM-TOOL-022, LLM-TOOL-024
  private calls = new Map<number, { id?: string; name?: string; args?: unknown }>();
  private last: number | undefined;
  add(c: WireCall): void {
    let i = c.index;
    if (i === undefined && c.id !== undefined) {
      for (const [k, v] of this.calls) if (v.id === c.id) { i = k; break; }
    }
    i ??= c.fragment && c.id === undefined && this.last !== undefined ? this.last : Math.max(-1, ...this.calls.keys()) + 1;
    this.last = i;
    const cur = this.calls.get(i) ?? {};
    if (c.id !== undefined) cur.id = c.id;
    if (c.name !== undefined) cur.name ??= c.name;
    if (typeof c.args === "string") cur.args = (typeof cur.args === "string" ? cur.args : "") + c.args;
    else if (c.args !== undefined) cur.args = c.args;
    this.calls.set(i, cur);
  }
  /** Removes the call at content index `i`: the cap cut it off (LLM-TOOL-022). */
  drop(i: number): void { this.calls.delete(i); }
  build(capped: boolean, dropCut: boolean): ToolCall[] {
    const out: ToolCall[] = [];
    for (const i of [...this.calls.keys()].sort((a, b) => a - b)) {
      const c = this.calls.get(i)!;
      // A call the cap cut before its arguments began (no arguments, or blank) is incomplete too.
      const unbegun = c.args === undefined || (typeof c.args === "string" && c.args.trim() === "");
      if (capped && dropCut && (unbegun || cutOff(c.args))) continue;
      out.push({ id: c.id ?? `call_${i}`, name: c.name ?? "", ...parseArguments(c.args) });
    }
    return out;
  }
}

/**
 * The finish of a reply (LLM-IF-013 to LLM-IF-016): the token cap beats everything; a reply that asked for tools, or holds
 * calls, is `tool_calls`; anything else is `stop`.
 */
function finishOf(capped: boolean, asked: boolean, calls: ToolCall[], refused = false): ChatResult["finish"] { // @spec LLM-IF-013, LLM-IF-014, LLM-IF-015, LLM-IF-016, LLM-STREAM-027
  return refused ? "refusal" : capped ? "length" : asked || calls.length > 0 ? "tool_calls" : "stop";
}

/** The result of a reply: trimmed text (LLM-IF-006), the calls in order, and the assistant message to append (LLM-IF-007, LLM-IF-022). */
function resultOf(content: string | null | undefined, finish: ChatResult["finish"], toolCalls: ToolCall[], continuation?: unknown): ChatResult { // @spec LLM-IF-005, LLM-IF-006, LLM-IF-007, LLM-IF-022, LLM-CHAT-007, LLM-TOOL-021, LLM-TOOL-014
  const text = (content ?? "").trim();
  return {
    text, toolCalls, finish,
    message: { role: "assistant", content: text, ...(toolCalls.length ? { toolCalls } : {}), ...(continuation !== undefined ? { continuation } : {}) },
  };
}

/** Ollama's history: a result is `{role: "tool", tool_name, content}`; a call goes back with its arguments as an object (LLM-TOOL-005, LLM-TOOL-017, LLM-TOOL-028). */
function ollamaMessages(messages: ChatMessage[]): object[] { // @spec LLM-TOOL-005, LLM-TOOL-017, LLM-TOOL-018, LLM-TOOL-019, LLM-TOOL-028
  return messages.map((m) => {
    if (m.role === "tool") return { role: "tool", tool_name: m.name, content: m.content };
    if (m.role === "assistant" && m.toolCalls?.length) {
      return { role: "assistant", content: m.content, tool_calls: m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.invalid !== undefined ? {} : c.arguments } })) };
    }
    if (m.role === "user" && m.images !== undefined) return { role: "user", content: m.content, images: m.images };
    return { role: m.role, content: m.content };
  });
}

/** OpenAI's history: a result is `{role: "tool", tool_call_id, content}`; calls go back with JSON-string arguments and `null` content when empty (LLM-TOOL-008, LLM-TOOL-009, LLM-TOOL-027). */
function openaiMessages(messages: ChatMessage[]): object[] { // @spec LLM-VIS-002, LLM-VIS-007, LLM-TOOL-008, LLM-TOOL-009, LLM-TOOL-017, LLM-TOOL-018, LLM-TOOL-019, LLM-TOOL-025, LLM-TOOL-027
  return messages.map((m) => {
    if (m.role === "tool") return { role: "tool", tool_call_id: m.callId, content: m.content };
    // A user turn with images is one text part (omitted when empty) then one data-URL image part per image (LLM-VIS-002); without images it stays a string (LLM-VIS-007).
    if (m.role === "user" && m.images?.length) {
      const text = m.content === "" ? [] : [{ type: "text", text: m.content }];
      return { role: "user", content: [...text, ...m.images.map((data) => ({ type: "image_url", image_url: { url: `data:${sniffImage(data)};base64,${data}` } }))] };
    }
    if (m.role === "assistant" && m.toolCalls?.length) {
      return {
        role: "assistant",
        content: m.content === "" ? null : m.content,
        tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.invalid !== undefined ? {} : c.arguments) } })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

/** OpenAI's `tool_calls` of a whole message or choice, by position (LLM-TOOL-007, LLM-TOOL-020). */
function openaiCalls(list: any[] | undefined): WireCall[] {
  return (list ?? []).map((c, i) => ({ index: i, id: c?.id, name: c?.function?.name, args: c?.function?.arguments }));
}

/** Ollama's `message.tool_calls`, whole, in order (LLM-TOOL-004). */
function ollamaCalls(list: any[] | undefined): WireCall[] {
  return (list ?? []).map((c) => ({ name: c?.function?.name, args: c?.function?.arguments }));
}

// ---------------------------------------------------------------------------

/** One event of a streamed reply as a provider frames it. `final` is the backend's last event, with the cap, tool and refusal flags; `end` is the backend closing its reply before a final event; `document` is a reply that arrived as one JSON document (LLM-STREAM-029). */
type WireEvent =
  | { kind: "content"; text: string }
  | { kind: "call"; call: WireCall }
  | { kind: "keepalive" }
  | { kind: "final"; capped: boolean; asked: boolean; refused?: boolean }
  | { kind: "end" }
  | { kind: "document"; value: unknown }
  /** A completed provider content block, by its content index, that the reply keeps for its continuation (LLM-TOOL-014); not output. */
  | { kind: "block"; index: number; block: unknown }
  /** The token cap cut off the call at this content index, so it is dropped (LLM-TOOL-022). */
  | { kind: "cut"; index: number };
/** A line of a framed body as a provider's line framing reads it; `whole` starts a reply that arrives as one JSON document (LLM-STREAM-029). */
type LineEvent = WireEvent | { kind: "whole" };

/** Starts a streamed reply under the signal the stream machinery supplies. Resolves once the backend has answered, and rejects with a `ChatError` before that. */
type Opener = (signal: AbortSignal) => Promise<AsyncIterable<WireEvent>>;

/** What a provider adds to the shared streamed-reply machinery: how it opens the reply, and how a single JSON body reads. */
interface StreamPlan {
  name: string;
  timeoutMs: number;
  /** Whether the token cap can cut a call's arguments on this backend, so the cut call is dropped (LLM-TOOL-022). */
  dropCut: boolean;
  /** Synchronous; a throw here is a programming error and surfaces unwrapped (LLM-IF-021). Returns the opener that runs under the clocks. */
  begin(): Opener;
  /** A backend that ignored `stream:true` and answered one JSON document (LLM-STREAM-029). Absent where no such reply is possible. */
  whole?(json: any): { text: string | null | undefined; capped: boolean; asked: boolean; calls: WireCall[] };
  /** The continuation of a finished reply, from its kept content blocks in the order the backend sent them (LLM-TOOL-014). Absent where the backend keeps none. */
  continuation?(blocks: unknown[]): unknown;
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

/** A single JSON document that arrived on a stream, parsed (LLM-STREAM-029). */
function parseWhole(name: string, text: string): unknown {
  try { return JSON.parse(text); } catch { throw streamError(name, "the single JSON body is not JSON"); }
}

/** The lines of a fetched body as they arrive; the last one is yielded even without a newline. */
async function* linesOf(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<string> {
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
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

/** The events of a fetched response: a non-2xx status is `http` (LLM-STREAM-020), a JSON body is one document (LLM-STREAM-029), and any other body is framed line by line by the provider. */
async function* framedResponse(name: string, res: Response, line: (line: string) => LineEvent[]): AsyncGenerator<WireEvent> {
  if (!res.ok) {
    const body = await res.text();
    throw new ChatError("http", `${name} chat ${res.status}: ${body}`, res.status); // @spec LLM-STREAM-020, LLM-ERR-004, LLM-CHAT-020
  }
  if (!res.body) throw streamError(name, "the response had no body");
  if ((res.headers.get("content-type") ?? "").startsWith("application/json")) { // @spec LLM-STREAM-029
    yield { kind: "document", value: parseWhole(name, await res.text()) };
    return;
  }
  const reader = res.body.getReader();
  try {
    let wholeText: string | undefined;
    for await (const text of linesOf(reader)) { // @spec LLM-STREAM-002, LLM-STREAM-005
      if (wholeText !== undefined) { wholeText += `\n${text}`; continue; } // @spec LLM-STREAM-029
      for (const ev of line(text)) {
        if (ev.kind === "whole") { wholeText = text; break; } // @spec LLM-STREAM-029
        yield ev;
      }
    }
    if (wholeText !== undefined) yield { kind: "document", value: parseWhole(name, wholeText) }; // @spec LLM-STREAM-029
  } finally {
    reader.cancel().catch(() => {});
  }
}

/** The opener of a fetch-framed backend: it sends the request under the signal the stream machinery supplies. */
const fetchOpener = (name: string, url: string, init: RequestInit, line: (line: string) => LineEvent[]) =>
  (signal: AbortSignal): Promise<AsyncIterable<WireEvent>> => fetch(url, { ...init, signal }).then((res) => framedResponse(name, res, line));

/**
 * The streamed call every streaming provider runs. Nothing runs until the first read (LLM-IF-008), and a failure of any kind
 * surfaces from that read (LLM-IF-021). Two clocks, each `timeoutMs`, run only while a read is pending (LLM-STREAM-034,
 * LLM-STREAM-035): the first-output clock from the request until the backend sends content or a call fragment (keepalives do not
 * stop it, LLM-STREAM-015), and the between-events clock after that, which any backend event restarts (LLM-STREAM-016). The caller's
 * signal adds a way to cancel and never replaces either clock (LLM-STREAM-018). Abort by the caller rethrows the caller's reason
 * (LLM-STREAM-026, LLM-ERR-006). Failures after the response began are `stream` (LLM-STREAM-021). Calls are delivered once the
 * backend has reported how the reply ended, after the text and before `done` (LLM-STREAM-012).
 */
async function* streamReply(plan: StreamPlan, messages: ChatMessage[], opts: ChatRequest): AsyncGenerator<ChatEvent> { // @spec LLM-IF-008, LLM-IF-009, LLM-IF-010, LLM-IF-021, LLM-STREAM-012, LLM-STREAM-032
  checkRequest(opts); // @spec LLM-TOOL-001, LLM-TOOL-002
  const open = plan.begin(); // @spec LLM-STREAM-001, LLM-STREAM-004, LLM-STREAM-014, LLM-STOP-012, LLM-STOP-014, LLM-STOP-018
  const caller = opts.signal;
  const ac = new AbortController();
  /** A caller that aborted (before the call, or between reads) gets its reason, never another event (LLM-STREAM-026). */
  const throwIfAborted = () => { if (caller?.aborted) throw caller.reason; };
  throwIfAborted();
  const onCallerAbort = () => ac.abort(caller?.reason);
  caller?.addEventListener("abort", onCallerAbort, { once: true });

  let timedOut = false;
  let responded = false;
  let sawOutput = false;
  const firstStart = Date.now();
  let mark = firstStart;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let events: AsyncIterator<WireEvent> | undefined;
  const trimmer = new TextTrimmer();
  const calls = new CallAssembler();
  const blocks = new Map<number, unknown>(); // @spec LLM-TOOL-014

  /** Runs one pending step under the clock, and maps what it throws. */
  const clocked = async <T>(step: () => Promise<T>): Promise<T> => {
    const due = (sawOutput ? mark : firstStart) + plan.timeoutMs;
    timer = setTimeout(() => { timedOut = true; ac.abort(); }, Math.max(0, due - Date.now()));
    try {
      const value = await step();
      // A source that ends quietly when its request is aborted (the SDK's stream does) still reports the abort's cause.
      if (timedOut) throw timeoutError(plan.timeoutMs);
      if (caller?.aborted) throw caller.reason;
      return value;
    } catch (e) {
      if (timedOut) throw timeoutError(plan.timeoutMs);
      if (caller?.aborted) throw caller.reason;
      if (e instanceof ChatError) throw e;
      throw responded
        ? streamError(plan.name, `the connection failed mid-reply: ${String(e)}`)
        : new ChatError("connect", `cannot reach ${plan.name}: ${String(e)}`);
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    const opened = await clocked(() => open(ac.signal));
    responded = true;
    mark = Date.now();
    events = opened[Symbol.asyncIterator]();
    let capped = false;
    let asked = false;
    let refused = false;
    let finished = false;
    for (;;) {
      const step = await clocked(() => events!.next());
      if (step.done) break;
      const ev = step.value;
      if (ev.kind === "keepalive") { mark = Date.now(); continue; }
      if (ev.kind === "block") { blocks.set(ev.index, ev.block); mark = Date.now(); continue; } // @spec LLM-TOOL-014
      if (ev.kind === "cut") { calls.drop(ev.index); blocks.delete(ev.index); mark = Date.now(); continue; } // @spec LLM-TOOL-022
      if (ev.kind === "document") { // @spec LLM-STREAM-029
        if (sawOutput) throw streamError(plan.name, "a JSON object arrived after stream events");
        if (ev.value && typeof ev.value === "object" && (ev.value as { error?: unknown }).error !== undefined) {
          throw backendError(plan.name, (ev.value as { error: unknown }).error); // @spec LLM-STREAM-023
        }
        if (!plan.whole) throw streamError(plan.name, "the backend sent a JSON body on a stream");
        const one = plan.whole(ev.value); // @spec LLM-STREAM-029
        sawOutput = true;
        const delta = trimmer.push(one.text ?? "");
        if (delta) { yield { type: "text", delta }; throwIfAborted(); }
        for (const c of one.calls) calls.add(c);
        capped = one.capped;
        asked = one.asked;
        finished = true;
        continue;
      }
      if (ev.kind === "end") throw streamError(plan.name, "the reply ended before its final event"); // @spec LLM-STREAM-037, LLM-STREAM-022
      sawOutput = true;
      if (ev.kind === "final") { capped = ev.capped; asked = ev.asked; refused = ev.refused === true; finished = true; break; } // @spec LLM-STREAM-036, LLM-IF-016, LLM-IF-017, LLM-IF-019, LLM-STREAM-027, LLM-STREAM-031
      if (ev.kind === "call") { calls.add(ev.call); mark = Date.now(); continue; } // @spec LLM-STREAM-003, LLM-STREAM-006
      const delta = trimmer.push(ev.text);
      mark = Date.now();
      if (delta) { yield { type: "text", delta }; mark = Date.now(); throwIfAborted(); } // @spec LLM-STREAM-010, LLM-STREAM-026
    }
    if (!finished) throw streamError(plan.name, "the reply ended before its final event"); // @spec LLM-STREAM-022
    throwIfAborted(); // @spec LLM-STREAM-026
    // A refused reply delivers no calls and no continuation, as complete() resolves none (LLM-CLAUDE-021, LLM-STREAM-038).
    const toolCalls = refused ? [] : calls.build(capped, plan.dropCut); // @spec LLM-TOOL-022, LLM-TOOL-023, LLM-STREAM-012, LLM-STREAM-038
    for (const call of toolCalls) {
      throwIfAborted();
      yield { type: "tool_call", call }; // @spec LLM-STREAM-003, LLM-STREAM-006, LLM-STREAM-012, LLM-STREAM-032
      throwIfAborted(); // @spec LLM-STREAM-026
    }
    const ordered = [...blocks].sort(([a], [b]) => a - b).map(([, block]) => block);
    const continuation = refused ? undefined : plan.continuation?.(ordered); // @spec LLM-TOOL-014, LLM-STREAM-038
    yield { type: "done", result: resultOf(trimmer.raw, finishOf(capped, asked, toolCalls, refused), toolCalls, continuation) }; // @spec LLM-IF-009, LLM-STREAM-009, LLM-STREAM-028, LLM-STREAM-033
  } finally {
    clearTimeout(timer);
    caller?.removeEventListener("abort", onCallerAbort);
    // Closing the event source releases the connection (the fetch reader, or the SDK stream) when the caller stopped early.
    if (events?.return) Promise.resolve(events.return(undefined)).catch(() => {});
    if (!ac.signal.aborted) ac.abort(); // @spec LLM-IF-010
  }
}

/** Ollama's framing: one JSON object per line; `content` is text, `message.tool_calls` are calls, and `done: true` is the final line (LLM-STREAM-002, LLM-STREAM-003). */
function ollamaLine(line: string): LineEvent[] { // @spec LLM-STREAM-002, LLM-STREAM-003
  if (!line.trim()) return [];
  const j = parseChunk("ollama", line);
  if (j?.error !== undefined) throw backendError("ollama", j.error); // @spec LLM-STREAM-023
  const evs: WireEvent[] = [];
  const content = j?.message?.content;
  if (typeof content === "string" && content !== "") evs.push({ kind: "content", text: content });
  for (const call of ollamaCalls(j?.message?.tool_calls)) evs.push({ kind: "call", call });
  if (evs.length === 0) evs.push({ kind: "keepalive" });
  if (j?.done) evs.push({ kind: "final", capped: j.done_reason === "length", asked: false });
  return evs;
}

/** OpenAI-compatible framing: SSE. `data:` chunks carry `delta.content` and `delta.tool_calls` fragments, and the `finish_reason` chunk is final; `[DONE]` before it ends the reply without one (LLM-STREAM-004, LLM-STREAM-006, LLM-STREAM-037). A line that starts with `{` is a single JSON body (LLM-STREAM-029). Comments and other fields are keepalives. */
function openaiLine(line: string): LineEvent[] { // @spec LLM-STREAM-004, LLM-STREAM-005, LLM-STREAM-006, LLM-STREAM-029
  if (!line.trim()) return [];
  if (line.trimStart().startsWith("{")) { // @spec LLM-STREAM-029
    // A raw JSON line: an `error` field is the backend's failure; otherwise it starts a single-body reply (streamReply decides).
    try { const j = JSON.parse(line); if (j?.error !== undefined) throw backendError("openai", j.error); } catch (e) { if (e instanceof ChatError) throw e; }
    return [{ kind: "whole" }];
  }
  if (!line.startsWith("data:")) return [{ kind: "keepalive" }];
  const payload = line.slice(5).trim();
  if (payload === "[DONE]") return [{ kind: "end" }];
  const chunk = parseChunk("openai", payload);
  if (chunk?.error !== undefined) throw backendError("openai", chunk.error); // @spec LLM-STREAM-023
  const choice = chunk?.choices?.[0];
  const evs: WireEvent[] = [];
  const content = choice?.delta?.content;
  if (typeof content === "string" && content !== "") evs.push({ kind: "content", text: content });
  for (const c of choice?.delta?.tool_calls ?? []) {
    evs.push({ kind: "call", call: { index: c?.index, id: c?.id, name: c?.function?.name, args: c?.function?.arguments, fragment: true } }); // @spec LLM-TOOL-007
  }
  if (evs.length === 0) evs.push({ kind: "keepalive" });
  if (choice?.finish_reason) evs.push({ kind: "final", capped: choice.finish_reason === "length", asked: choice.finish_reason === "tool_calls" });
  return evs;
}

/** A `stream` ChatError carrying the message the backend sent in an `error` field (a string, or an object with `message`). */
function backendError(name: string, error: unknown): ChatError {
  const message = typeof error === "string" ? error : (error as { message?: unknown } | null)?.message;
  return streamError(name, `the backend reported an error: ${typeof message === "string" ? message : JSON.stringify(error)}`);
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
  private body(messages: ChatMessage[], opts: ChatRequest, streaming: boolean): string { // @spec LLM-CHAT-001, LLM-CHAT-004, LLM-CHAT-006, LLM-VIS-001, LLM-VIS-008, LLM-VIS-009, LLM-CHAT-011, LLM-CHAT-015, LLM-CHAT-019, LLM-CHAT-021, LLM-STOP-011, LLM-CHAT-016, LLM-CHAT-022, LLM-TOOL-003
    return JSON.stringify({
      model: this.cfg.model,
      messages: ollamaMessages(messages),
      stream: streaming,
      keep_alive: "24h",
      ...(opts.json ? { format: "json" } : {}), // @spec LLM-CHAT-010
      tools: wireTools(opts),
      options: {
        temperature: opts.temperature ?? this.cfg.temperature,
        num_ctx: this.cfg.num_ctx,
        num_predict: opts.maxTokens ?? this.cfg.max_tokens,
        stop: stopsFor(opts), // @spec LLM-STOP-001, LLM-STOP-003, LLM-STOP-012
      },
    });
  }

  /** The one non-streamed `/api/chat` request that `chat()` and `complete()` both send. */
  private async send(messages: ChatMessage[], opts: ChatRequest): Promise<{ message?: { content?: string | null; tool_calls?: any[] }; done_reason?: string }> { // @spec LLM-CHAT-001
    const res = await sendRequest(this.name, `${this.base}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: this.body(messages, opts, false),
      signal: requestSignal(this.cfg, opts.signal), // @spec LLM-CHAT-008
    });
    if (!res.ok) throw new ChatError("http", `ollama chat ${res.status}: ${await res.text()}`, res.status); // @spec LLM-CHAT-005, LLM-ERR-007
    return (await res.json()) as { message?: { content?: string | null; tool_calls?: any[] }; done_reason?: string };
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> { // @spec LLM-IF-011, LLM-IF-004
    assertTextHistory(messages);
    return (await this.complete(messages, { ...opts, tools: undefined })).text;
  }

  async complete(messages: ChatMessage[], req: ChatRequest = {}): Promise<ChatResult> { // @spec LLM-IF-005, LLM-IF-013, LLM-IF-014, LLM-IF-015, LLM-IF-016, LLM-IF-019, LLM-TOOL-004, LLM-TOOL-024, LLM-TOOL-001, LLM-TOOL-002
    checkRequest(req);
    const json = await this.send(messages, req);
    const capped = json.done_reason === "length";
    const calls = new CallAssembler();
    for (const c of ollamaCalls(json.message?.tool_calls)) calls.add(c);
    const toolCalls = calls.build(capped, false);
    return resultOf(json.message?.content, finishOf(capped, false, toolCalls), toolCalls);
  }

  /** A streamed reply (LLM-IF-008): nothing is sent until the first read. */
  stream(messages: ChatMessage[], opts: ChatRequest = {}): AsyncGenerator<ChatEvent> { // @spec LLM-IF-008, LLM-STREAM-001, LLM-STREAM-002
    return streamReply({
      name: this.name,
      timeoutMs: this.cfg.timeout_ms,
      dropCut: false,
      begin: () => fetchOpener(this.name, `${this.base}/api/chat`,
        { method: "POST", headers: { "content-type": "application/json" }, body: this.body(messages, opts, true) }, ollamaLine),
      whole: (j) => ({ text: j?.message?.content, capped: j?.done_reason === "length", asked: false, calls: ollamaCalls(j?.message?.tool_calls) }),
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
  constructor(private cfg: Config["llm"]) {
    this.model = cfg.model;
    this.base = cfg.openai.base_url.replace(/\/+$/, "");
  }

  private headers(): Record<string, string> { // @spec LLM-CHAT-003
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.cfg.openai.api_key) h.authorization = `Bearer ${this.cfg.openai.api_key}`;
    return h;
  }

  /** The `/chat/completions` body that `chat()`, `complete()` and `stream()` send; `streaming` sets `stream` (LLM-STREAM-004). */
  private body(messages: ChatMessage[], opts: ChatRequest, streaming: boolean): string { // @spec LLM-CHAT-002, LLM-CHAT-004, LLM-CHAT-006, LLM-CHAT-012, LLM-CHAT-013, LLM-CHAT-015, LLM-CHAT-019, LLM-CHAT-021, LLM-STOP-013, LLM-CHAT-022, LLM-CHAT-016, LLM-TOOL-006
    return JSON.stringify({
      model: this.cfg.model,
      messages: openaiMessages(messages), // @spec LLM-VIS-002, LLM-VIS-007, LLM-VIS-010, LLM-VIS-011
      stream: streaming,
      temperature: opts.temperature ?? this.cfg.temperature,
      max_tokens: opts.maxTokens ?? this.cfg.max_tokens,
      tools: wireTools(opts),
      ...(opts.json ? { response_format: { type: "json_object" } } : {}), // @spec LLM-CHAT-010
      stop: stopsFor(opts), // @spec LLM-STOP-002, LLM-STOP-003, LLM-STOP-014, LLM-STOP-018
    });
  }

  /** The one non-streamed `/chat/completions` request that `chat()` and `complete()` both send. */
  private async send(messages: ChatMessage[], opts: ChatRequest): Promise<{ choices?: { message?: { content?: string | null; tool_calls?: any[] }; finish_reason?: string | null }[] }> { // @spec LLM-CHAT-002
    const res = await sendRequest(this.name, `${this.base}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: this.body(messages, opts, false),
      signal: requestSignal(this.cfg, opts.signal), // @spec LLM-CHAT-008
    });
    if (!res.ok) throw new ChatError("http", `${this.name} chat ${res.status}: ${await res.text()}`, res.status); // @spec LLM-CHAT-005, LLM-ERR-007
    return (await res.json()) as { choices?: { message?: { content?: string | null; tool_calls?: any[] }; finish_reason?: string | null }[] };
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> { // @spec LLM-IF-011, LLM-IF-004
    assertTextHistory(messages);
    return (await this.complete(messages, { ...opts, tools: undefined })).text;
  }

  async complete(messages: ChatMessage[], req: ChatRequest = {}): Promise<ChatResult> { // @spec LLM-IF-005, LLM-IF-013, LLM-IF-014, LLM-IF-015, LLM-IF-016, LLM-IF-017, LLM-TOOL-007, LLM-TOOL-020, LLM-TOOL-024, LLM-TOOL-022, LLM-TOOL-001, LLM-TOOL-002
    checkRequest(req);
    const json = await this.send(messages, req);
    const choice = json.choices?.[0];
    const capped = choice?.finish_reason === "length";
    const calls = new CallAssembler();
    for (const c of openaiCalls(choice?.message?.tool_calls)) calls.add(c);
    const toolCalls = calls.build(capped, true);
    return resultOf(choice?.message?.content, finishOf(capped, choice?.finish_reason === "tool_calls", toolCalls), toolCalls);
  }

  /** A streamed reply (LLM-IF-008): nothing is sent until the first read. */
  stream(messages: ChatMessage[], opts: ChatRequest = {}): AsyncGenerator<ChatEvent> { // @spec LLM-IF-008, LLM-STREAM-004, LLM-STREAM-005, LLM-CHAT-014, LLM-STREAM-006
    return streamReply({
      name: this.name,
      timeoutMs: this.cfg.timeout_ms,
      dropCut: true,
      begin: () => fetchOpener(this.name, `${this.base}/chat/completions`,
        { method: "POST", headers: this.headers(), body: this.body(messages, opts, true) }, openaiLine),
      whole: (j) => {
        const choice = j?.choices?.[0];
        return { text: choice?.message?.content, capped: choice?.finish_reason === "length", asked: choice?.finish_reason === "tool_calls", calls: openaiCalls(choice?.message?.tool_calls) };
      },
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

/**
 * A user turn as Claude content: plain text, or with images one base64 `image` block per image before the text block (LLM-VIS-003).
 * An empty text is omitted; `images: []` stays plain text (LLM-VIS-013).
 */
function claudeUserContent(m: Extract<ChatMessage, { role: "user" }>): string | Anthropic.ContentBlockParam[] { // @spec LLM-VIS-003, LLM-VIS-012, LLM-VIS-013
  if (!m.images?.length) return m.content;
  const images = m.images.map((data): Anthropic.ImageBlockParam => ({ type: "image", source: { type: "base64", media_type: sniffImage(data), data } }));
  return m.content === "" ? images : [...images, { type: "text", text: m.content }];
}

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

  constructor(protected cfg: Config["llm"]) {
    this.model = cfg.model;
  }

  /**
   * The request body `chat()`, `complete()` and `stream()` share: joined `system`, the `(begin)` turn, `max_tokens`, effort and no
   * temperature (LLM-CLAUDE-023 to LLM-CLAUDE-030). Fallbacks go on a non-streamed anthropic request only (LLM-CLAUDE-007, LLM-CLAUDE-022).
   */
  private params(allMessages: ChatMessage[], req: ChatRequest, streaming: boolean): Omit<Anthropic.Beta.MessageCreateParamsNonStreaming, "stream"> { // @spec LLM-CLAUDE-023, LLM-CLAUDE-024, LLM-CLAUDE-025, LLM-CLAUDE-026, LLM-CLAUDE-027, LLM-CLAUDE-028, LLM-CLAUDE-029, LLM-CLAUDE-030
    const system = allMessages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n"); // @spec LLM-CLAUDE-001
    const turns = this.turns(allMessages);
    if (turns.length === 0 || turns[0]!.role !== "user") turns.unshift({ role: "user", content: "(begin)" }); // @spec LLM-CLAUDE-002

    // The caller's budget is honoured (thinking shares it; hooks run at low effort), down to the API's minimum of 1.
    const maxTokens = req.maxTokens === undefined ? this.cfg.claude.max_tokens : Math.max(CLAUDE_MIN_MAX_TOKENS, Math.floor(req.maxTokens)); // @spec LLM-CLAUDE-003
    const tools = hasTools(req)
      ? req.tools!.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters as Anthropic.Beta.BetaTool.InputSchema })) // @spec LLM-TOOL-010
      : undefined;
    return {
      model: this.cfg.model,
      max_tokens: maxTokens,
      system: system || undefined,
      messages: turns,
      output_config: { effort: this.cfg.claude.effort }, // @spec LLM-CLAUDE-004
      ...(tools ? { tools } : {}),
      ...(req.json || tools ? {} : { stop_sequences: TRANSCRIPT_STOPS }), // @spec LLM-STOP-003, LLM-STOP-004, LLM-STOP-010, LLM-STOP-015, LLM-STOP-016, LLM-STOP-017, LLM-STOP-019
      // Safety classifiers can decline; server-side fallback re-runs on another Claude model
      // in the same call. Not offered on Bedrock, where a refusal just means "say nothing", and never on a stream (LLM-CLAUDE-022).
      ...(this.serverFallbacks && !streaming ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}), // @spec LLM-CLAUDE-007, LLM-CLAUDE-008, LLM-CLAUDE-032
    };
  }

  /**
   * The history as Claude's turns. Consecutive `tool` messages share one user turn of `tool_result` blocks, in the order given, each
   * answering its own `callId` (LLM-TOOL-012, LLM-TOOL-025); an assistant turn with calls is built by `assistantContent` (LLM-TOOL-013).
   */
  private turns(messages: ChatMessage[]): Anthropic.MessageParam[] { // @spec LLM-TOOL-012, LLM-TOOL-013, LLM-TOOL-025
    const out: Anthropic.MessageParam[] = [];
    let resultsOpen = false;
    for (const m of messages) {
      if (m.role === "system") continue;
      if (m.role === "tool") {
        const block: Anthropic.ToolResultBlockParam = { type: "tool_result", tool_use_id: m.callId, content: m.content, ...(m.isError ? { is_error: true } : {}) };
        if (resultsOpen) (out.at(-1)!.content as Anthropic.ContentBlockParam[]).push(block);
        else { out.push({ role: "user", content: [block] }); resultsOpen = true; }
        continue;
      }
      resultsOpen = false;
      if (m.role === "user") out.push({ role: "user", content: claudeUserContent(m) });
      else out.push({ role: "assistant", content: this.assistantContent(m) });
    }
    return out;
  }

  /** An assistant turn: a plain one is its text. One with calls and its own continuation is sent back verbatim from the continuation's blocks (LLM-TOOL-013); without one, a text block when content is non-empty, then one `tool_use` per call (LLM-TOOL-013, LLM-TOOL-015, LLM-TOOL-017). */
  private assistantContent(m: Extract<ChatMessage, { role: "assistant" }>): string | Anthropic.ContentBlockParam[] { // @spec LLM-TOOL-013, LLM-TOOL-015, LLM-TOOL-017
    if (!m.toolCalls?.length) return m.content;
    const own = ownContinuation(m.continuation, this.name);
    if (own) return own.content as Anthropic.ContentBlockParam[];
    const text: Anthropic.TextBlockParam[] = m.content === "" ? [] : [{ type: "text", text: m.content }];
    const uses = m.toolCalls.map((c): Anthropic.ToolUseBlockParam => ({ type: "tool_use", id: c.id, name: c.name, input: c.invalid !== undefined ? {} : c.arguments }));
    return [...text, ...uses];
  }

  async chat(allMessages: ChatMessage[], opts: ChatOptions = {}): Promise<string> { // @spec LLM-IF-011, LLM-IF-012
    assertTextHistory(allMessages);
    return (await this.complete(allMessages, opts)).text;
  }

  async complete(allMessages: ChatMessage[], req: ChatRequest = {}): Promise<ChatResult> { // @spec LLM-IF-005, LLM-IF-006, LLM-IF-007, LLM-IF-013, LLM-IF-014, LLM-IF-015, LLM-CLAUDE-010, LLM-CLAUDE-020, LLM-CLAUDE-021, LLM-CLAUDE-031, LLM-CLAUDE-033, LLM-CHAT-017, LLM-ERR-003, LLM-ERR-002, LLM-ERR-009
    checkRequest(req); // @spec LLM-TOOL-001, LLM-TOOL-002
    // The body is built before the client check, so image data in no supported format is a TypeError whatever the configuration (LLM-VIS-005).
    const params = this.params(allMessages, req, false);
    const client = this.client;
    if (!client) throw new ChatError("not_configured", this.notConfigured()); // @spec LLM-CLAUDE-017, LLM-CLAUDE-018
    // The caller's signal when it passed one; otherwise llm.timeout_ms, as the Ollama and OpenAI-compatible providers bound theirs.
    // A timeout is one request the SDK does not retry, and it rejects with the TimeoutError of LLM-ERR-005 (LLM-CHAT-018).
    const caller = req.signal;
    const signal = caller ?? AbortSignal.timeout(this.cfg.timeout_ms); // @spec LLM-CHAT-006, LLM-CHAT-008, LLM-CHAT-018
    let res: Anthropic.Beta.BetaMessage;
    try {
      res = await client.beta.messages.create(params, { signal });
    } catch (e) {
      if (!caller && signal.aborted) throw timeoutError(this.cfg.timeout_ms); // @spec LLM-ERR-005
      throw sdkFailure(this.name, e, caller);
    }
    if (res.stop_reason === "refusal") return resultOf("", "refusal", []); // @spec LLM-CLAUDE-006, LLM-CLAUDE-021
    // A reply the token cap cut off ends in the call it was writing; that call's arguments never finished, so it is dropped (LLM-TOOL-022).
    const capped = res.stop_reason === "max_tokens";
    const content = capped && res.content.at(-1)?.type === "tool_use" ? res.content.slice(0, -1) : res.content;
    const text = content // @spec LLM-CLAUDE-005, LLM-CLAUDE-031, LLM-IF-004, LLM-STREAM-013
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const toolCalls: ToolCall[] = content // @spec LLM-TOOL-011, LLM-TOOL-020, LLM-TOOL-024
      .filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use")
      .map((b) => ({ id: b.id, name: b.name, ...parseArguments(b.input) }));
    return resultOf(text, finishOf(capped, res.stop_reason === "tool_use", toolCalls), toolCalls, claudeContinuation(this.name, content)); // @spec LLM-IF-014, LLM-IF-015, LLM-IF-018, LLM-TOOL-014
  }

  /** A streamed reply (LLM-IF-008): the SDK's streaming request, read under the stream machinery's clocks. */
  stream(messages: ChatMessage[], opts: ChatRequest = {}): AsyncGenerator<ChatEvent> { // @spec LLM-IF-008, LLM-STREAM-007, LLM-STREAM-008, LLM-STREAM-013, LLM-STREAM-017, LLM-STREAM-021, LLM-STREAM-027, LLM-STREAM-031, LLM-STREAM-033, LLM-STOP-016, LLM-CLAUDE-022, LLM-CLAUDE-024, LLM-CLAUDE-026, LLM-CLAUDE-028, LLM-CLAUDE-030
    return streamReply({
      name: this.name,
      timeoutMs: this.cfg.timeout_ms,
      dropCut: false, // the cap's cut is a `cut` event from the stream (LLM-TOOL-022)
      continuation: (blocks) => claudeContinuation(this.name, blocks), // @spec LLM-TOOL-014
      begin: () => {
        const params = this.params(messages, opts, true);
        return async (signal) => {
          const client = this.client;
          if (!client) throw new ChatError("not_configured", this.notConfigured()); // @spec LLM-ERR-003
          const events = await sdkCall(this.name, signal, () => client.beta.messages.create({ ...params, stream: true }, { signal }));
          return claudeEvents(this.name, events);
        };
      },
    }, messages, opts);
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

/**
 * Maps an SDK failure from a Claude request before its reply began: an HTTP status is `http` with that status (LLM-ERR-002); every
 * other failure is `connect` with no status (LLM-ERR-009), so a caller only ever sees a ChatError (LLM-ERR-001). A caller's abort (or
 * the stream's clock, which aborts the same signal) passes its reason through.
 */
function sdkFailure(name: string, e: unknown, signal?: AbortSignal): unknown { // @spec LLM-ERR-002, LLM-ERR-009
  if (signal?.aborted) return signal.reason;
  if (e instanceof ChatError) return e;
  const err = e as { name?: unknown; status?: unknown; message?: unknown } | null;
  if (e instanceof Anthropic.APIConnectionError || err?.name === "APIConnectionError" || err?.name === "APIConnectionTimeoutError") {
    return new ChatError("connect", `cannot reach ${name}: ${String(err?.message)}`);
  }
  if (typeof err?.status === "number") return new ChatError("http", `${name} chat ${err.status}: ${String(err.message)}`, err.status);
  // Any other failure of a request that got no usable answer is a connection failure (LLM-ERR-001): the SDK's connection errors and
  // timeouts, and the errors it raises for a body it cannot use.
  return new ChatError("connect", `${name} request failed before its reply: ${String(err?.message ?? e)}`);
}

/** Awaits one SDK request, mapping its failure with `sdkFailure`. */
async function sdkCall<T>(name: string, signal: AbortSignal | undefined, call: () => Promise<T>): Promise<T> {
  try { return await call(); } catch (e) { throw sdkFailure(name, e, signal); }
}

/** An open Claude content block, assembled from its deltas until it stops (LLM-TOOL-011, LLM-TOOL-014). */
type OpenBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "tool_use"; id: string; name: string; start: Record<string, unknown>; partial?: string };

/** The arguments of a streamed `tool_use` block from its joined `input_json_delta` text; a blank or unparsable text is `{}` (a cut call is dropped before it matters). */
function assembledInput(raw: string): Record<string, unknown> {
  if (raw.trim() === "") return {};
  try { return asObject(JSON.parse(raw))?.arguments ?? {}; } catch { return {}; }
}

/**
 * The SDK's stream events as wire events. A `tool_use` block is a call: its id and name come at its start (with its `input` when
 * the start carries one), and its `input_json_delta` fragments join by block index (LLM-STREAM-030, LLM-TOOL-011, LLM-TOOL-022); a
 * call with no input at all is `{}` when its block stops. Every completed content block is kept as a `block`, by index, so the
 * continuation holds the reply's blocks in order (LLM-TOOL-014). When the token cap ends the reply on a `tool_use` block, that
 * call is cut off (LLM-TOOL-022). Text deltas are content; the other deltas are keepalives, so they restart the between-events clock
 * but are not output (LLM-STREAM-008, LLM-STREAM-017).
 */
async function* claudeEvents(name: string, events: AsyncIterable<Anthropic.Beta.BetaRawMessageStreamEvent>): AsyncGenerator<WireEvent> { // @spec LLM-STREAM-030, LLM-TOOL-011, LLM-TOOL-014, LLM-TOOL-022
  const open = new Map<number, OpenBlock>();
  const kinds = new Map<number, string>();
  for await (const ev of events) {
    if (ev.type === "content_block_start") {
      const b = ev.content_block;
      kinds.set(ev.index, b.type);
      if (b.type === "text") {
        open.set(ev.index, { type: "text", text: b.text });
        yield b.text ? { kind: "content", text: b.text } : { kind: "keepalive" };
        continue;
      }
      if (b.type === "thinking") {
        open.set(ev.index, { type: "thinking", thinking: b.thinking, signature: b.signature });
        yield { kind: "keepalive" };
        continue;
      }
      if (b.type === "redacted_thinking") { yield { kind: "block", index: ev.index, block: { type: "redacted_thinking", data: b.data } }; continue; }
      if (b.type === "tool_use") {
        const input = (b.input ?? {}) as Record<string, unknown>;
        open.set(ev.index, { type: "tool_use", id: b.id, name: b.name, start: input });
        const hasInput = Object.keys(input).length > 0;
        yield { kind: "call", call: { index: ev.index, id: b.id, name: b.name, ...(hasInput ? { args: input } : {}) } }; // @spec LLM-TOOL-011
        continue;
      }
    } else if (ev.type === "content_block_delta") {
      const o = open.get(ev.index);
      const d = ev.delta;
      if (d.type === "text_delta") {
        if (o?.type === "text") o.text += d.text;
        yield { kind: "content", text: d.text };
        continue;
      }
      if (d.type === "thinking_delta" && o?.type === "thinking") { o.thinking += d.thinking; yield { kind: "keepalive" }; continue; }
      if (d.type === "signature_delta" && o?.type === "thinking") { o.signature = d.signature; yield { kind: "keepalive" }; continue; }
      if (d.type === "input_json_delta" && o?.type === "tool_use") {
        o.partial = (o.partial ?? "") + d.partial_json;
        yield { kind: "call", call: { index: ev.index, args: d.partial_json } }; // @spec LLM-STREAM-030
        continue;
      }
    } else if (ev.type === "content_block_stop") {
      const o = open.get(ev.index);
      if (o) {
        open.delete(ev.index);
        if (o.type === "text") { yield { kind: "block", index: ev.index, block: { type: "text", text: o.text } }; continue; }
        if (o.type === "thinking") { yield { kind: "block", index: ev.index, block: { type: "thinking", thinking: o.thinking, signature: o.signature } }; continue; }
        if (o.partial === undefined && Object.keys(o.start).length === 0) yield { kind: "call", call: { index: ev.index, args: "{}" } }; // a call with no arguments at all
        yield { kind: "block", index: ev.index, block: { type: "tool_use", id: o.id, name: o.name, input: o.partial !== undefined ? assembledInput(o.partial) : o.start } };
        continue;
      }
    } else if (ev.type === "message_delta" && ev.delta.stop_reason === "max_tokens" && kinds.size > 0) {
      // The cap ended the reply: a tool_use at the reply's last block index is the call it was writing, and is dropped (LLM-TOOL-022).
      const top = Math.max(...kinds.keys());
      if (kinds.get(top) === "tool_use") yield { kind: "cut", index: top };
    }
    yield claudeEvent(name, ev);
  }
}

function claudeEvent(name: string, ev: Anthropic.Beta.BetaRawMessageStreamEvent): WireEvent { // @spec LLM-STREAM-021, LLM-STREAM-027, LLM-STREAM-031, LLM-IF-018
  if (ev.type === "message_delta") { // the final message delta carries the stop reason (LLM-STREAM-031, LLM-IF-018)
    return ev.delta.stop_reason
      ? { kind: "final", capped: ev.delta.stop_reason === "max_tokens", asked: ev.delta.stop_reason === "tool_use", refused: ev.delta.stop_reason === "refusal" }
      : { kind: "keepalive" };
  }
  // The SDK types no `error` event (it throws one itself); an unexpected one still fails the reply (LLM-STREAM-021).
  if ((ev as { type: string }).type === "error") throw streamError(name, "the backend reported an error mid-reply"); // @spec LLM-STREAM-021
  return { kind: "keepalive" };
}

/**
 * What a Claude reply keeps for the turn that answers its calls (LLM-TOOL-014): its content blocks (thinking, redacted_thinking, text
 * and tool_use) in the order the API sent them, sent back verbatim on the next request. `name` is the producing provider; another
 * provider's continuation is ignored (LLM-TOOL-015, LLM-TOOL-030).
 */
interface ClaudeContinuation {
  name: string;
  content: unknown[];
}

const KEPT_BLOCKS = new Set(["thinking", "redacted_thinking", "text", "tool_use"]);

/** The continuation of a Claude reply whose content holds thinking or calls; undefined for a plain text reply (LLM-TOOL-014). */
function claudeContinuation(name: string, blocks: unknown[]): ClaudeContinuation | undefined { // @spec LLM-TOOL-014, LLM-TOOL-030
  const content = blocks.filter((b) => KEPT_BLOCKS.has((b as { type: string }).type));
  if (!content.some((b) => (b as { type: string }).type !== "text")) return undefined;
  return { name, content };
}

/** The continuation an assistant message carries for this provider, or undefined when it has none or another provider wrote it (LLM-TOOL-015). */
function ownContinuation(continuation: unknown, name: string): ClaudeContinuation | undefined { // @spec LLM-TOOL-015
  const c = continuation as Partial<ClaudeContinuation> | null | undefined;
  return c && c.name === name && Array.isArray(c.content) ? (c as ClaudeContinuation) : undefined;
}

/** The Claude API's own endpoint: the SDK would otherwise take `ANTHROPIC_BASE_URL` (LLM-CLAUDE-009). */
const CLAUDE_API_BASE_URL = "https://api.anthropic.com";

// @spec LLM-CLAUDE-009, LLM-CLAUDE-017
export class AnthropicProvider extends ClaudeBase {
  readonly name = "anthropic";
  protected client: Anthropic | undefined;
  protected serverFallbacks: boolean;
  constructor(cfg: Config["llm"], deps: ClaudeDeps = {}) {
    super(cfg);
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
  constructor(cfg: Config["llm"], deps: ClaudeDeps = {}) {
    super(cfg);
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
