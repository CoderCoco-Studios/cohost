import type { Config } from "@cohost/config";
import type { Memory, MemoryKind, MemoryBackend } from "./store.js";

const DIMS = 64;

/** Bag-of-words hashed into a unit vector: texts sharing words score high, no model needed. */
export function hashEmbed(text: string): number[] {
  const v = new Array<number>(DIMS).fill(0);
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []) {
    let h = 2166136261;
    for (const ch of word) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619) >>> 0;
    v[h % DIMS]! += 1;
  }
  const norm = Math.hypot(...v);
  return norm === 0 ? v : v.map((x) => x / norm);
}

interface Row extends Memory { embedding: number[] }

/**
 * Memory in a JS array, no Ollama or Postgres (`brain.memory.store: memory`).
 * Same behaviour as MemoryStore, forgetful across restarts, for dev and CI.
 */
export class InMemoryStore implements MemoryBackend {
  private rows: Row[] = [];
  private viewers = new Map<string, { msgCount: number; notes: string }>();
  private meta = new Map<string, string>();

  constructor(private cfg: Config["brain"]["memory"], private clock: () => number = Date.now) {}

  async init(): Promise<void> {}

  async remember(kind: MemoryKind, who: string, text: string): Promise<void> {
    this.rows.push({ id: this.rows.length + 1, ts: new Date(this.clock()), kind, who, text, embedding: hashEmbed(`${who}: ${text}`) });
  }

  async recall(query: string, k = this.cfg.recall_k): Promise<Memory[]> {
    if (k <= 0) return [];
    const q = hashEmbed(query);
    const cutoff = this.clock() - 2 * 60_000;
    return this.rows
      .filter((r) => r.ts.getTime() < cutoff)
      .map(({ embedding, ...m }) => ({ ...m, similarity: embedding.reduce((n, x, i) => n + x * q[i]!, 0) }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, k)
      .filter((m) => m.similarity >= this.cfg.min_similarity);
  }

  async touchViewer(userKey: string, _display: string): Promise<{ msgCount: number; notes: string; isNew: boolean }> {
    const key = userKey.toLowerCase();
    const v = this.viewers.get(key) ?? { msgCount: 0, notes: "" };
    v.msgCount++;
    this.viewers.set(key, v);
    return { msgCount: v.msgCount, notes: v.notes, isNew: v.msgCount <= 1 };
  }

  async recentSince(ts: Date, limit = 400): Promise<Memory[]> {
    return this.rows
      .filter((r) => r.ts > ts)
      .slice(0, limit)
      .map(({ embedding: _e, ...m }) => m);
  }

  async getMeta(k: string): Promise<string | undefined> { return this.meta.get(k); }
  async setMeta(k: string, v: string): Promise<void> { this.meta.set(k, v); }
  async close(): Promise<void> {}
}
