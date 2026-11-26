/**
 * Offline backends for isolated runs (`llm.provider: mock`, `brain.memory.embedder: hash`).
 * Deterministic and dependency-free: same input, same output. Opt-in only, never a default.
 */
import type { ChatEvent, ChatMessage, ChatOptions, ChatProvider, ChatRequest, ChatResult, Embedder, ToolCall } from "./index.js";
import { ChatError } from "./index.js";
import { assertTextHistory } from "./history.js";
import { checkRequest } from "./request.js";

/** `[mock-tool <name> ` up to its arguments: the name is one token (LLM-MOCK-009). */
const TOOL_HEAD = /\[mock-tool ([^\s\]]+) /;
/** `[mock-fail-after <n>]` with a non-negative integer `n` (LLM-MOCK-014). */
const FAIL_AFTER = /\[mock-fail-after (\d+)\]/;

/** Whitespace-collapsed, trimmed and cut to `max` characters. */
const collapse = (s: string, max: number): string => s.replace(/\s+/g, " ").trim().slice(0, max);

/** The `chat()` reply: `[happy] mock: <last user message>`, or `hello` when there is none (LLM-MOCK-001). */
function plainText(messages: ChatMessage[]): string {
  const last = [...messages].toReversed().find((m) => m.role === "user")?.content ?? "";
  return `[happy] mock: ${collapse(last, 80) || "hello"}`;
}

const textResult = (text: string): ChatResult => ({ text, toolCalls: [], finish: "stop", message: { role: "assistant", content: text } });

/** What `complete()` returns, and where `stream()` must stop: `failAfter` is set when the reply is cut short after that many words. */
interface Plan { result: ChatResult; failAfter?: number }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The arguments of a `[mock-tool]` marker, given the text after `[mock-tool <name> `: the shortest prefix ending before a `]`
 * that `JSON.parse` accepts, so a later marker in the paragraph does not join them (LLM-MOCK-009). When none parses, the text
 * up to the final `]` is kept as `invalid` (LLM-MOCK-013). Undefined when there is no `]` at all.
 */
function markerArguments(rest: string): { arguments: Record<string, unknown>; invalid?: string } | undefined {
  const ends: number[] = [];
  for (let i = rest.indexOf("]"); i !== -1; i = rest.indexOf("]", i + 1)) ends.push(i);
  if (ends.length === 0) return undefined;
  for (const end of ends) {
    const candidate = rest.slice(0, end);
    let v: unknown;
    try { v = JSON.parse(candidate); } catch { continue; }
    return isObject(v) ? { arguments: v } : { arguments: {}, invalid: candidate };
  }
  return { arguments: {}, invalid: rest.slice(0, ends[ends.length - 1]) };
}

/**
 * The tool call a `[mock-tool]` marker in the last paragraph of the last message asks for, when that message is the user
 * message and the name is offered (LLM-MOCK-009, LLM-MOCK-012, LLM-MOCK-016). The id is `mock_call_<n>`, one more than the
 * tool calls already in the history (LLM-MOCK-010).
 */
function markerCall(messages: ChatMessage[], req: ChatRequest): ToolCall | undefined { // @spec LLM-MOCK-009, LLM-MOCK-012, LLM-MOCK-013, LLM-MOCK-016
  const last = messages.at(-1);
  if (last?.role !== "user") return undefined;
  const paragraph = last.content.split(/\n\s*\n/).at(-1) ?? "";
  const head = TOOL_HEAD.exec(paragraph);
  if (!head || !req.tools?.some((t) => t.name === head[1])) return undefined;
  const parsed = markerArguments(paragraph.slice(head.index + head[0].length));
  if (!parsed) return undefined;
  const priorCalls = messages.reduce((n, m) => n + (m.role === "assistant" ? (m.toolCalls?.length ?? 0) : 0), 0);
  const call: ToolCall = { id: `mock_call_${priorCalls + 1}`, name: head[1]!, arguments: parsed.arguments }; // @spec LLM-MOCK-010
  if (parsed.invalid !== undefined) call.invalid = parsed.invalid;
  return call;
}

const callResult = (call: ToolCall): ChatResult => ({ text: "", toolCalls: [call], finish: "tool_calls", message: { role: "assistant", content: "", toolCalls: [call] } });

/**
 * The one decision both `complete()` and `stream()` make. `json: true` is decided first (LLM-MOCK-020). A tool last message is
 * answered with its content and no tool call is read from the markers (LLM-MOCK-011). Otherwise a `[mock-tool]` marker in the
 * last user message's last paragraph gives a call (LLM-MOCK-009, LLM-MOCK-016). `[mock-fail-after]` is read from the last user
 * message in every case, and fires when `n` is below the reply's word count (LLM-MOCK-014, LLM-MOCK-015, LLM-MOCK-016, LLM-MOCK-017).
 */
function decide(messages: ChatMessage[], req: ChatRequest): Plan { // @spec LLM-MOCK-011, LLM-MOCK-012, LLM-MOCK-014, LLM-MOCK-015, LLM-MOCK-016, LLM-MOCK-020
  if (req.json) return { result: textResult("{}") };
  const last = messages.at(-1);
  let result: ChatResult;
  if (last?.role === "tool") {
    result = textResult(`[happy] mock: ${last.name} said ${collapse(last.content, 80)}`);
  } else {
    const call = markerCall(messages, req);
    if (call) return { result: callResult(call) };
    result = textResult(plainText(messages));
  }
  const user = [...messages].toReversed().find((m) => m.role === "user")?.content ?? "";
  const fail = FAIL_AFTER.exec(user);
  const words = result.text === "" ? 0 : result.text.split(" ").length;
  const failAfter = fail && Number(fail[1]) < words ? Number(fail[1]) : undefined;
  return { result, failAfter };
}

/** Echo-style provider: `[happy] mock: <last user message>`, in the tag format the cortex parses. */
export class MockProvider implements ChatProvider { // @spec LLM-MOCK-004
  readonly name = "mock";
  readonly model: string;
  lastError?: string;
  constructor(cfg: { model: string }) { this.model = cfg.model; }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> { // @spec LLM-MOCK-001, LLM-IF-011, LLM-IF-012, LLM-MOCK-018, LLM-MOCK-019
    assertTextHistory(messages);
    if (opts.signal?.aborted) throw new Error("mock chat aborted"); // @spec LLM-MOCK-003
    // Hooks (module.kind: llm) parse JSON; {} is valid and makes them fall back to their rules.
    if (opts.json) return "{}"; // @spec LLM-MOCK-002, HOOK-FALLBACK-006
    return plainText(messages);
  }

  /** The same reply as `stream()` delivers; markers act here (LLM-MOCK-009, LLM-MOCK-014, LLM-MOCK-015, LLM-MOCK-017). Images are never read (LLM-VIS-006). */
  async complete(messages: ChatMessage[], req: ChatRequest = {}): Promise<ChatResult> { // @spec LLM-MOCK-006, LLM-MOCK-017, LLM-MOCK-021, LLM-VIS-006, LLM-TOOL-001, LLM-TOOL-002
    checkRequest(req);
    if (req.signal?.aborted) throw new Error("mock chat aborted"); // @spec LLM-MOCK-021
    const plan = decide(messages, req);
    if (plan.failAfter !== undefined) throw new ChatError("stream", `mock stream failed after ${plan.failAfter} words`); // @spec LLM-MOCK-017
    return plan.result;
  }

  /** Text word by word, then tool calls, then `done`; the signal is checked before each event (LLM-MOCK-008). Images are never read (LLM-VIS-006). */
  async *stream(messages: ChatMessage[], opts: ChatRequest = {}): AsyncGenerator<ChatEvent> { // @spec LLM-MOCK-007, LLM-MOCK-008, LLM-MOCK-014, LLM-MOCK-015, LLM-VIS-006, LLM-TOOL-001, LLM-TOOL-002, LLM-IF-021
    checkRequest(opts);
    const plan = decide(messages, opts);
    const beforeEvent = (): void => { if (opts.signal?.aborted) throw opts.signal.reason; };
    const words = plan.result.text === "" ? [] : plan.result.text.split(" ");
    const deltas = words.map((w, i) => (i === 0 ? w : ` ${w}`));
    const shown = plan.failAfter === undefined ? deltas : deltas.slice(0, plan.failAfter);
    for (const delta of shown) { beforeEvent(); yield { type: "text", delta }; }
    if (plan.failAfter !== undefined) { beforeEvent(); throw new ChatError("stream", `mock stream failed after ${plan.failAfter} words`); } // @spec LLM-MOCK-014
    for (const call of plan.result.toolCalls) { beforeEvent(); yield { type: "tool_call", call }; }
    beforeEvent();
    yield { type: "done", result: plan.result };
  }

  async ping(): Promise<boolean> { return true; }
}

export const HASH_DIMS = 64;

/** FNV-1a, 32-bit. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/**
 * Bag-of-tokens hashing into 64 dims, L2-normalised. Texts sharing tokens get a
 * positive cosine similarity; empty text yields a valid (fixed) unit vector.
 */
export class HashEmbedder implements Embedder {
  async embed(text: string): Promise<number[]> { // @spec LLM-EMBED-005
    const v = new Array<number>(HASH_DIMS).fill(0);
    for (const tok of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
      const h = fnv1a(tok);
      v[h % HASH_DIMS] = (v[h % HASH_DIMS] ?? 0) + ((h >>> 16) & 1 ? 1 : -1);
    }
    let norm = Math.hypot(...v);
    if (norm === 0) { v[0] = 1; norm = 1; } // @spec LLM-EMBED-006
    return v.map((x) => x / norm);
  }
}
