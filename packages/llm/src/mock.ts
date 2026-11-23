/**
 * Offline backends for isolated runs (`llm.provider: mock`, `brain.memory.embedder: hash`).
 * Deterministic and dependency-free: same input, same output. Opt-in only, never a default.
 */
import type { ChatEvent, ChatMessage, ChatOptions, ChatProvider, ChatRequest, ChatResult, Embedder, ToolCall } from "./index.js";
import { ChatError } from "./index.js";
import { assertTextHistory } from "./history.js";

/** `[mock-tool <name> <json>]`: the name is one token, the arguments run greedily to the marker's final `]` (LLM-MOCK-009). */
const TOOL_MARKER = /\[mock-tool ([^\s\]]+) ([\s\S]*)\]/;
/** `[mock-fail-after <n>]` with a non-negative integer `n` (LLM-MOCK-014). */
const FAIL_AFTER = /\[mock-fail-after (\d+)\]/;

/** Whitespace-collapsed, trimmed and cut to `max` characters. */
const collapse = (s: string, max: number): string => s.replace(/\s+/g, " ").trim().slice(0, max);

/** The `chat()` reply: `[happy] mock: <last user message>`, or `hello` when there is none (LLM-MOCK-001). */
function plainText(messages: ChatMessage[]): string {
  const last = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  return `[happy] mock: ${collapse(last, 80) || "hello"}`;
}

const textResult = (text: string): ChatResult => ({ text, toolCalls: [], finish: "stop", message: { role: "assistant", content: text } });

/** What `complete()` returns, and where `stream()` must stop: `failAfter` is set when the reply is cut short after that many words. */
interface Plan { result: ChatResult; failAfter?: number }

/**
 * The one decision both `complete()` and `stream()` make. `json: true` is decided first (LLM-MOCK-020). A tool last message
 * wins over any marker and is answered with its content (LLM-MOCK-011). Otherwise the markers are read from the last user
 * message only: `[mock-tool]` from its last paragraph (LLM-MOCK-009, LLM-MOCK-016), offered names only (LLM-MOCK-012), and
 * `[mock-fail-after]` from anywhere in that message (LLM-MOCK-014, LLM-MOCK-015, LLM-MOCK-016).
 */
function decide(messages: ChatMessage[], req: ChatRequest): Plan { // @spec LLM-MOCK-009, LLM-MOCK-011, LLM-MOCK-012, LLM-MOCK-013, LLM-MOCK-014, LLM-MOCK-015, LLM-MOCK-016, LLM-MOCK-020
  if (req.json) return { result: textResult("{}") };
  const last = messages.at(-1);
  if (last?.role === "tool") return { result: textResult(`[happy] mock: ${last.name} said ${collapse(last.content, 80)}`) };

  const user = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  // A tool call marker counts only when the last message itself is the user message (LLM-MOCK-009).
  const paragraph = last?.role === "user" ? (last.content.split(/\n\s*\n/).at(-1) ?? "") : "";
  const tool = TOOL_MARKER.exec(paragraph);
  if (tool && req.tools?.some((t) => t.name === tool[1])) {
    const priorCalls = messages.reduce((n, m) => n + (m.role === "assistant" ? (m.toolCalls?.length ?? 0) : 0), 0);
    const raw = tool[2] ?? "";
    let parsed: { arguments: Record<string, unknown>; invalid?: string } = { arguments: {}, invalid: raw };
    try {
      const v: unknown = JSON.parse(raw);
      if (typeof v === "object" && v !== null && !Array.isArray(v)) parsed = { arguments: v as Record<string, unknown> };
    } catch { /* not JSON: the raw text stays as `invalid` */ }
    const call: ToolCall = { id: `mock_call_${priorCalls + 1}`, name: tool[1]!, arguments: parsed.arguments };
    if (parsed.invalid !== undefined) call.invalid = parsed.invalid;
    return { result: { text: "", toolCalls: [call], finish: "tool_calls", message: { role: "assistant", content: "", toolCalls: [call] } } };
  }

  const text = plainText(messages);
  const fail = FAIL_AFTER.exec(user);
  const failAfter = fail && Number(fail[1]) < text.split(" ").length ? Number(fail[1]) : undefined;
  return { result: textResult(text), failAfter };
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
  async complete(messages: ChatMessage[], req: ChatRequest = {}): Promise<ChatResult> { // @spec LLM-MOCK-006, LLM-MOCK-017, LLM-MOCK-021, LLM-VIS-006
    if (req.signal?.aborted) throw new Error("mock chat aborted"); // @spec LLM-MOCK-021
    const plan = decide(messages, req);
    if (plan.failAfter !== undefined) throw new ChatError("stream", `mock stream failed after ${plan.failAfter} words`); // @spec LLM-MOCK-017
    return plan.result;
  }

  /** Text word by word, then tool calls, then `done`; the signal is checked before each event (LLM-MOCK-008). Images are never read (LLM-VIS-006). */
  async *stream(messages: ChatMessage[], opts: ChatRequest = {}): AsyncGenerator<ChatEvent> { // @spec LLM-MOCK-007, LLM-MOCK-008, LLM-MOCK-014, LLM-MOCK-015, LLM-VIS-006
    const plan = decide(messages, opts);
    const beforeEvent = (): void => { if (opts.signal?.aborted) throw opts.signal.reason; };
    const words = plan.result.text === "" ? [] : plan.result.text.split(" ");
    const deltas = words.map((w, i) => (i === 0 ? w : ` ${w}`));
    const shown = plan.failAfter === undefined ? deltas : deltas.slice(0, plan.failAfter);
    for (const delta of shown) { beforeEvent(); yield { type: "text", delta }; }
    if (plan.failAfter !== undefined) throw new ChatError("stream", `mock stream failed after ${plan.failAfter} words`); // @spec LLM-MOCK-014
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
