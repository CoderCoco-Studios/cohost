/**
 * Offline backends for isolated runs (`llm.provider: mock`, `brain.memory.embedder: hash`).
 * Deterministic and dependency-free: same input, same output. Opt-in only, never a default.
 */
import type { ChatMessage, ChatOptions, ChatProvider, Embedder } from "./index.js";

/** Echo-style provider: `[happy] mock: <last user message>`, in the tag format the cortex parses. */
export class MockProvider implements ChatProvider {
  readonly name = "mock";
  readonly model: string;
  lastError?: string;
  constructor(cfg: { model: string }) { this.model = cfg.model; }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
    if (opts.signal?.aborted) throw new Error("mock chat aborted");
    // Hooks (module.kind: llm) parse JSON; {} is valid and makes them fall back to their rules.
    if (opts.json) return "{}";
    const last = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const text = last.replace(/\s+/g, " ").trim().slice(0, 80) || "hello";
    return `[happy] mock: ${text}`;
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
  async embed(text: string): Promise<number[]> {
    const v = new Array<number>(HASH_DIMS).fill(0);
    for (const tok of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
      const h = fnv1a(tok);
      v[h % HASH_DIMS] = (v[h % HASH_DIMS] ?? 0) + ((h >>> 16) & 1 ? 1 : -1);
    }
    let norm = Math.hypot(...v);
    if (norm === 0) { v[0] = 1; norm = 1; }
    return v.map((x) => x / norm);
  }
}
