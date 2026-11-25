import type { Config } from "@cohost/config";
import { HashEmbedder } from "@cohost/llm";
import type { ReflectCursor } from "./cursor.js";
import type { ChatIds, ChatRemoval, Memory, MemoryKind, MemoryBackend, ReembedResult, ViewerTouch } from "./store.js";
import {
  checkedDiscordId, clamp01, effectiveStrength, isNameKeyed, isReadableViewer, looksLikeKey, isVoiceKey, reinforcedStrength, voiceKey, withDefaultHint,
  type DeletionRow, type LinkResult, type LinkRow, type NewNote, type NoteOp, type NoteRow, type ViewerRow, type ViewerSummary,
} from "./notes.js";

/** The one deterministic offline embedder (`@cohost/llm`'s `HashEmbedder`), the same one hash mode uses (MEM-BACKEND-004). */
const embedder = new HashEmbedder();
const hashEmbed = (text: string): Promise<number[]> => embedder.embed(text);

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
  private links = new Map<string, { userKey: string; discordDisplay: string | null; updatedAt: number }>();
  private nextNoteId = 1;
  private nextDeletionId = 1;
  private lockHeld = false;
  private meta = new Map<string, string>();

  constructor(private cfg: Config["brain"]["memory"], private clock: () => number = Date.now) {}

  async init(): Promise<void> {}

  async connect(): Promise<void> {}

  /** Nothing persists, so nothing is stored at another dimension. */
  async reembed(): Promise<ReembedResult> { return { dims: (await embedder.embed("hello")).length, tables: {} }; }

  // @spec MEM-WRITE-009, MEM-BACKEND-005
  async remember(kind: MemoryKind, who: string, text: string, ids: ChatIds = {}): Promise<void> {
    const chat = { ...(ids.platform ? { platform: ids.platform } : {}), ...(ids.userId ? { userId: ids.userId } : {}), ...(ids.messageId ? { messageId: ids.messageId } : {}) };
    this.rows.push({ id: this.rows.length + 1, ts: new Date(this.clock()), kind, who, text, ...chat, embedding: await hashEmbed(`${who}: ${text}`) });
  }

  // @spec MEM-FORGET-002, MEM-FORGET-003, MEM-FORGET-004, MEM-FORGET-005
  async forgetChat(r: ChatRemoval): Promise<void> {
    if (r.scope === "all") return;
    // A removal names its key; without it no row matches, as a NULL column never equals anything in Postgres (MEM-FORGET-005).
    if (r.scope === "message" ? !r.messageId : !r.userId) return;
    const hit = (row: Row): boolean => row.kind === "chat" && row.platform === r.platform
      && (r.scope === "message" ? row.messageId === r.messageId : row.userId === r.userId);
    this.rows = this.rows.filter((row) => !hit(row));
  }

  // @spec MEM-BACKEND-004, MEM-RECALL-002, MEM-RECALL-004, MEM-RECALL-005
  async recall(query: string, k = this.cfg.recall_k): Promise<Memory[]> {
    if (k <= 0) return [];
    const q = await hashEmbed(query);
    const cutoff = this.clock() - 2 * 60_000;
    return this.rows
      .filter((r) => r.ts.getTime() < cutoff)
      .map(({ embedding, ...m }) => ({ ...m, similarity: embedding.reduce((n, x, i) => n + x * q[i]!, 0) }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, k)
      .filter((m) => m.similarity >= this.cfg.min_similarity);
  }

  // @spec MEM-BACKEND-005, MEM-VIEWER-008, MEM-REG-001, MEM-REG-004, MEM-REG-005
  async touchViewer(userKey: string, display: string, opts: { isSub?: boolean } = {}): Promise<ViewerTouch> {
    const key = userKey;
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
    return { msgCount: v.msgCount, isNew: v.msgCount <= 1, regular: v.regular };
  }

  /** Move a viewer row, with its notes and deletions, to a new key. */
  private rekey(v: ViewerRow, key: string): ViewerRow {
    this.viewers.delete(v.key);
    for (const n of this.notes.values()) if (n.userKey === v.key) n.userKey = key;
    for (const d of this.deletions) if (d.userKey === v.key) d.userKey = key;
    for (const l of this.links.values()) if (l.userKey === v.key) l.userKey = key;
    v.key = key;
    this.viewers.set(key, v);
    return v;
  }

  private refreshRegular(v: ViewerRow): void {
    v.regular = v.regularManual || v.msgCount > this.cfg.regular_messages;
  }

  async getViewer(userKey: string): Promise<ViewerRow | undefined> {
    const v = this.viewers.get(userKey);
    return v && isReadableViewer(v) ? { ...v } : undefined;
  }

  // @spec MEM-SURF-008
  async getLinkedViewer(discordId: string): Promise<ViewerRow | undefined> {
    let id: string;
    try { id = checkedDiscordId(discordId); } catch { return undefined; }
    const link = this.links.get(id);
    return link ? this.getViewer(link.userKey) : undefined;
  }

  // @spec MEM-SURF-006, MEM-VOICE-007
  async findNameKeyedViewerByDisplay(name: string): Promise<ViewerRow | undefined> {
    return this.latestByDisplay(name, (r) => isNameKeyed(r));
  }

  private latestByDisplay(name: string, admits: (r: ViewerRow) => boolean): ViewerRow | undefined {
    const want = name.toLowerCase();
    const v = [...this.viewers.values()]
      .filter((r) => admits(r) && r.display.toLowerCase() === want)
      .sort((a, b) => b.lastSeen.getTime() - a.lastSeen.getTime() || (a.key < b.key ? -1 : 1))[0];
    return v && { ...v };
  }

  // @spec MEM-VOICE-001
  async touchSpeaker(speakerId: string, display: string): Promise<ViewerRow> {
    const id = checkedDiscordId(speakerId);
    const now = new Date(this.clock());
    const link = this.links.get(id);
    const linked = link && this.viewers.get(link.userKey);
    if (link && linked) {
      link.discordDisplay = display;
      link.updatedAt = now.getTime();
      linked.lastSeen = now;
      return { ...linked };
    }
    const key = voiceKey(id);
    let v = this.viewers.get(key);
    if (!v) {
      v = { key, display, msgCount: 0, regularManual: false, isSub: false, placeholder: false, firstSeen: now, lastSeen: now, regular: false };
      this.viewers.set(key, v);
    }
    v.display = display;
    v.lastSeen = now;
    this.refreshRegular(v);
    return { ...v };
  }

  // @spec MEM-VOICE-005
  async linkDiscord(discordId: string, target: string): Promise<LinkResult | undefined> {
    const id = checkedDiscordId(discordId);
    const want = target.trim();
    const byKey = this.viewers.get(want);
    const t = byKey && isReadableViewer(byKey) ? byKey
      : [...this.viewers.values()].filter((r) => isReadableViewer(r) && r.display.toLowerCase() === want.toLowerCase()).sort((a, b) => b.lastSeen.getTime() - a.lastSeen.getTime())[0];
    if (!t || isVoiceKey(t.key)) return undefined;
    const voice = this.viewers.get(voiceKey(id));
    let moved = 0;
    if (voice) {
      for (const n of this.notes.values()) {
        if (n.userKey !== voice.key) continue;
        n.userKey = t.key;
        n.dirty = true; // the consolidator merges what now duplicates the chat viewer's notes
        n.version++;
        moved++;
      }
      for (const d of this.deletions) if (d.userKey === voice.key) d.userKey = t.key;
      this.viewers.delete(voice.key);
    }
    this.links.set(id, { userKey: t.key, discordDisplay: voice?.display ?? this.links.get(id)?.discordDisplay ?? null, updatedAt: this.clock() });
    return { viewer: { ...t }, moved };
  }

  // @spec MEM-VOICE-006
  async unlinkDiscord(discordId: string): Promise<boolean> {
    return this.links.delete(discordId.toLowerCase());
  }

  async listLinks(userKey: string): Promise<LinkRow[]> {
    const key = userKey;
    return [...this.links.entries()]
      .filter(([, l]) => l.userKey === key)
      .sort(([ia, a], [ib, b]) => a.updatedAt - b.updatedAt || (ia < ib ? -1 : 1))
      .map(([discordId, l]) => ({ discordId, discordDisplay: l.discordDisplay }));
  }

  // @spec MEM-CAPTURE-011, MEM-REG-004
  async ensureViewer(userKey: string, display: string): Promise<ViewerRow> {
    const key = userKey;
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
    const byKey = this.viewers.get(keyOrName);
    let v = byKey && isReadableViewer(byKey) ? byKey
      : [...this.viewers.values()].filter((r) => isReadableViewer(r) && r.display.toLowerCase() === keyOrName.toLowerCase()).sort((a, b) => b.lastSeen.getTime() - a.lastSeen.getTime())[0];
    if (!v) {
      if (!regular || looksLikeKey(keyOrName)) return undefined; // MEM-REG-006: an owner placeholder is named by a display name, never a key
      // MEM-REG-003: a placeholder keyed by the lower-cased name.
      const key = keyOrName.toLowerCase();
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
    const userKey = n.userKey;
    if (!this.viewers.has(userKey)) throw new Error(`no viewer row for ${userKey}`);
    const now = new Date(this.clock());
    const text = n.text.trim();
    const row: NoteRow = {
      id: this.nextNoteId++, userKey, layer: n.layer ?? "recent", category: n.category, text,
      hint: withDefaultHint(n.category, n.hint) ?? null,
      strength: clamp01(n.strength ?? 1), strengthAt: now, mentions: n.mentions ?? 1, dirty: n.dirty ?? true,
      version: 1, createdAt: now, lastSurfacedAt: null, embedding: n.embedding ?? await hashEmbed(text),
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
    return [...this.notes.values()].filter((n) => n.userKey === userKey).sort((a, b) => a.id - b.id).map((n) => ({ ...n }));
  }

  // @spec MEM-SURF-004
  async markSurfaced(noteIds: number[], at: Date): Promise<void> {
    for (const id of noteIds) {
      const n = this.notes.get(id);
      if (n) n.lastSurfacedAt = at;
    }
  }

  async listDeletions(userKey: string): Promise<DeletionRow[]> {
    return this.deletions.filter((d) => d.userKey === userKey).map((d) => ({ ...d }));
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

  // @spec MEM-ADMIN-001
  async listViewers(opts: { query?: string; limit?: number } = {}): Promise<ViewerSummary[]> {
    const q = opts.query?.trim().toLowerCase();
    const counts = new Map<string, number>();
    for (const n of this.notes.values()) counts.set(n.userKey, (counts.get(n.userKey) ?? 0) + 1);
    return [...this.viewers.values()]
      .filter((v) => isReadableViewer(v) && (!q || v.display.toLowerCase().includes(q)))
      .sort((a, b) => b.lastSeen.getTime() - a.lastSeen.getTime() || a.key.localeCompare(b.key))
      .slice(0, opts.limit ?? 500)
      .map((v) => ({ ...v, noteCount: counts.get(v.key) ?? 0 }));
  }

  // @spec MEM-ADMIN-004, MEM-NOTE-004
  async restoreDeletion(id: number): Promise<NoteRow | undefined> {
    const i = this.deletions.findIndex((d) => d.id === id);
    if (i < 0) return undefined;
    const [d] = this.deletions.splice(i, 1);
    const now = new Date(this.clock());
    const row: NoteRow = {
      id: this.nextNoteId++, userKey: d!.userKey, layer: d!.layer, category: d!.category, text: d!.text, hint: d!.hint,
      strength: clamp01(d!.strength), strengthAt: now, mentions: 1, dirty: false, version: 1, createdAt: now,
      lastSurfacedAt: null, embedding: d!.embedding,
    };
    this.notes.set(row.id, row);
    return { ...row };
  }

  // @spec MEM-ADMIN-005
  async clearNotes(userKey: string, reason?: string): Promise<number> {
    const ids = [...this.notes.values()].filter((n) => n.userKey === userKey).sort((a, b) => a.id - b.id).map((n) => n.id);
    for (const id of ids) await this.deleteNote(id, reason);
    return ids.length;
  }

  async dirtyNoteCount(): Promise<number> {
    return [...this.notes.values()].filter((n) => n.dirty).length;
  }

  async dirtyViewerKeys(): Promise<string[]> {
    return [...new Set([...this.notes.values()].filter((n) => n.dirty).map((n) => n.userKey))].sort();
  }

  // @spec MEM-CONSOL-007, MEM-CONSOL-008, MEM-NOTE-004
  async commitViewer(userKey: string, ops: NoteOp[]): Promise<void> {
    const key = userKey;
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
        if (set.text !== undefined) { n.text = set.text.trim(); n.embedding = await hashEmbed(n.text); }
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
