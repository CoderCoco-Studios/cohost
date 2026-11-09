import type { Config } from "@cohost/config";
import type { ReflectCursor } from "./cursor.js";
import type { Memory, MemoryKind, MemoryBackend, ViewerTouch } from "./store.js";
import {
  clamp01, effectiveStrength, reinforcedStrength, withDefaultHint,
  type DeletionRow, type NewNote, type NoteOp, type NoteRow, type ViewerRow,
} from "./notes.js";

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
  private viewers = new Map<string, ViewerRow>();
  private notes = new Map<number, NoteRow>();
  private deletions: DeletionRow[] = [];
  private nextNoteId = 1;
  private nextDeletionId = 1;
  private lockHeld = false;
  private meta = new Map<string, string>();

  constructor(private cfg: Config["brain"]["memory"], private clock: () => number = Date.now) {}

  async init(): Promise<void> {}

  async remember(kind: MemoryKind, who: string, text: string): Promise<void> {
    this.rows.push({ id: this.rows.length + 1, ts: new Date(this.clock()), kind, who, text, embedding: hashEmbed(`${who}: ${text}`) });
  }

  // @spec MEM-BACKEND-004, MEM-RECALL-002, MEM-RECALL-004, MEM-RECALL-005
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

  // @spec MEM-BACKEND-005, MEM-REG-001, MEM-REG-004, MEM-REG-005
  async touchViewer(userKey: string, display: string, opts: { isSub?: boolean } = {}): Promise<ViewerTouch> {
    const key = userKey.toLowerCase();
    const now = new Date(this.clock());
    let v = this.viewers.get(key);
    if (!v) {
      const placeholder = [...this.viewers.values()]
        .filter((r) => r.placeholder && r.display.toLowerCase() === display.toLowerCase())
        .sort((a, b) => b.lastSeen.getTime() - a.lastSeen.getTime())[0];
      if (placeholder) v = this.rekey(placeholder, key);
    }
    if (!v) {
      v = { key, display, msgCount: 0, regularManual: false, isSub: false, placeholder: false, firstSeen: now, lastSeen: now, regular: false };
      this.viewers.set(key, v);
    }
    v.msgCount++;
    v.display = display;
    v.lastSeen = now;
    v.placeholder = false;
    v.isSub = opts.isSub ?? false;
    this.refreshRegular(v);
    return { msgCount: v.msgCount, notes: "", isNew: v.msgCount <= 1, regular: v.regular };
  }

  /** Move a viewer row, with its notes and deletions, to a new key. */
  private rekey(v: ViewerRow, key: string): ViewerRow {
    this.viewers.delete(v.key);
    for (const n of this.notes.values()) if (n.userKey === v.key) n.userKey = key;
    for (const d of this.deletions) if (d.userKey === v.key) d.userKey = key;
    v.key = key;
    this.viewers.set(key, v);
    return v;
  }

  private refreshRegular(v: ViewerRow): void {
    v.regular = v.regularManual || v.msgCount > this.cfg.regular_messages;
  }

  async getViewer(userKey: string): Promise<ViewerRow | undefined> {
    const v = this.viewers.get(userKey.toLowerCase());
    return v && { ...v };
  }

  // @spec MEM-CAPTURE-011, MEM-REG-004
  async ensureViewer(userKey: string, display: string): Promise<ViewerRow> {
    const key = userKey.toLowerCase();
    let v = this.viewers.get(key);
    if (!v) {
      const placeholder = [...this.viewers.values()]
        .filter((r) => r.placeholder && r.display.toLowerCase() === display.toLowerCase())
        .sort((a, b) => b.lastSeen.getTime() - a.lastSeen.getTime())[0];
      if (placeholder) {
        v = this.rekey(placeholder, key);
        v.display = display;
        v.placeholder = false;
      } else {
        const now = new Date(this.clock());
        v = { key, display, msgCount: 0, regularManual: false, isSub: false, placeholder: false, firstSeen: now, lastSeen: now, regular: false };
        this.viewers.set(key, v);
      }
      this.refreshRegular(v);
    }
    return { ...v };
  }

  // @spec MEM-CAPTURE-005
  async embedText(text: string): Promise<number[]> {
    return hashEmbed(text);
  }

  // @spec MEM-REG-001, MEM-REG-003
  async setRegular(keyOrName: string, regular: boolean): Promise<ViewerRow | undefined> {
    const key = keyOrName.toLowerCase();
    let v = this.viewers.get(key)
      ?? [...this.viewers.values()].filter((r) => r.display.toLowerCase() === key).sort((a, b) => b.lastSeen.getTime() - a.lastSeen.getTime())[0];
    if (!v) {
      if (!regular) return undefined;
      const now = new Date(this.clock());
      v = { key, display: keyOrName, msgCount: 0, regularManual: true, isSub: false, placeholder: true, firstSeen: now, lastSeen: now, regular: true };
      this.viewers.set(key, v);
    }
    v.regularManual = regular;
    this.refreshRegular(v);
    return { ...v };
  }

  // @spec MEM-NOTE-001, MEM-NOTE-004, MEM-NOTE-010
  async insertNote(n: NewNote): Promise<NoteRow> {
    const userKey = n.userKey.toLowerCase();
    if (!this.viewers.has(userKey)) throw new Error(`no viewer row for ${userKey}`);
    const now = new Date(this.clock());
    const text = n.text.trim();
    const row: NoteRow = {
      id: this.nextNoteId++, userKey, layer: n.layer ?? "recent", category: n.category, text,
      hint: withDefaultHint(n.category, n.hint) ?? null,
      strength: clamp01(n.strength ?? 1), strengthAt: now, mentions: n.mentions ?? 1, dirty: n.dirty ?? true,
      version: 1, createdAt: now, lastSurfacedAt: null, embedding: n.embedding ?? hashEmbed(text),
    };
    this.notes.set(row.id, row);
    return { ...row };
  }

  // @spec MEM-NOTE-004, MEM-NOTE-005
  async reinforceNote(id: number): Promise<NoteRow | undefined> {
    const n = this.notes.get(id);
    if (!n) return undefined;
    const now = new Date(this.clock());
    n.strength = reinforcedStrength(effectiveStrength(n, now, this.cfg.notes), this.cfg.notes);
    n.strengthAt = now;
    n.mentions++;
    n.dirty = true;
    n.version++;
    return { ...n };
  }

  async listNotes(userKey: string): Promise<NoteRow[]> {
    return [...this.notes.values()].filter((n) => n.userKey === userKey.toLowerCase()).sort((a, b) => a.id - b.id).map((n) => ({ ...n }));
  }

  async listDeletions(userKey: string): Promise<DeletionRow[]> {
    return this.deletions.filter((d) => d.userKey === userKey.toLowerCase()).map((d) => ({ ...d }));
  }

  async deleteNote(id: number, reason?: string): Promise<boolean> {
    const n = this.notes.get(id);
    if (!n) return false;
    this.notes.delete(id);
    this.deletions.push({
      id: this.nextDeletionId++, userKey: n.userKey, layer: n.layer, category: n.category, text: n.text, hint: n.hint,
      strength: effectiveStrength(n, this.clock(), this.cfg.notes), reason: reason?.trim() || null,
      deletedAt: new Date(this.clock()), embedding: n.embedding,
    });
    return true;
  }

  async dirtyNoteCount(): Promise<number> {
    return [...this.notes.values()].filter((n) => n.dirty).length;
  }

  async dirtyViewerKeys(): Promise<string[]> {
    return [...new Set([...this.notes.values()].filter((n) => n.dirty).map((n) => n.userKey))].sort();
  }

  // @spec MEM-CONSOL-007, MEM-CONSOL-008, MEM-NOTE-004
  async commitViewer(userKey: string, ops: NoteOp[]): Promise<void> {
    const key = userKey.toLowerCase();
    const fresh = (id: number, version: number): NoteRow | undefined => {
      const n = this.notes.get(id);
      return n && n.userKey === key && n.version === version ? n : undefined;
    };
    for (const op of ops) {
      const n = fresh(op.id, op.version);
      if (!n) continue; // changed or deleted meanwhile: the newer state wins and the note stays dirty
      if (op.kind === "clean") n.dirty = false;
      else if (op.kind === "delete") this.notes.delete(n.id);
      else {
        const members = (op.absorb ?? []).map((m) => fresh(m.id, m.version));
        if (members.some((m) => !m)) continue;
        const { set } = op;
        if (set.layer) n.layer = set.layer;
        if (set.category) n.category = set.category;
        if (set.text !== undefined) { n.text = set.text.trim(); n.embedding = hashEmbed(n.text); }
        if (set.hint !== undefined) n.hint = set.hint;
        n.hint = withDefaultHint(n.category, n.hint) ?? null;
        if (set.strength !== undefined) n.strength = clamp01(set.strength);
        if (set.strengthAt) n.strengthAt = set.strengthAt;
        if (set.mentions !== undefined) n.mentions = set.mentions;
        n.dirty = false;
        n.version++;
        for (const m of members) this.notes.delete(m!.id);
      }
    }
  }

  // @spec MEM-CONSOL-016
  async purgeSoftDeletions(olderThan: Date): Promise<number> {
    const before = this.deletions.length;
    this.deletions = this.deletions.filter((d) => d.reason !== null || d.deletedAt.getTime() >= olderThan.getTime());
    return before - this.deletions.length;
  }

  // @spec MEM-CONSOL-010
  async withConsolidationLock<T>(fn: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> {
    if (this.lockHeld) return { ran: false };
    this.lockHeld = true;
    try { return { ran: true, value: await fn() }; } finally { this.lockHeld = false; }
  }

  // @spec MEM-BACKEND-006, MEM-REFLECT-008
  async recentSince(after: ReflectCursor, limit = 400): Promise<Memory[]> {
    const t = new Date(after.ts).getTime();
    return this.rows
      .filter((r) => r.ts.getTime() > t || (r.ts.getTime() === t && r.id > after.id))
      .sort((a, b) => a.ts.getTime() - b.ts.getTime() || a.id - b.id)
      .slice(0, limit)
      .map(({ embedding: _e, ...m }) => m);
  }

  // @spec MEM-BACKEND-006
  async getMeta(k: string): Promise<string | undefined> { return this.meta.get(k); }
  async setMeta(k: string, v: string): Promise<void> { this.meta.set(k, v); }
  async close(): Promise<void> {}
}
