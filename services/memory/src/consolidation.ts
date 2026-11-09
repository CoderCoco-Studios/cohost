import type { Config, Logger } from "@cohost/config";
import type { MemoryBackend } from "./store.js";
import type { ConsolidatorInput, ConsolidatorOp, ConsolidatorOutput } from "./consolidator.js";
import { validateOps } from "./consolidator.js";
import {
  cosine, effectiveStrength, reinforcedStrength, withDefaultHint,
  type Category, type DeletionRow, type Layer, type NoteChange, type NoteOp, type NoteRow,
} from "./notes.js";

export const META_LAST_CONSOLIDATION = "notes.last_consolidation";
export const META_SHUTDOWN_RUN_OWED = "notes.shutdown_run_owed";

/** What a pass needs from the `memory.consolidator` hook (a region-hooks `Module` satisfies it). */
export interface Consolidator { run(input: ConsolidatorInput): Promise<ConsolidatorOutput> }

export type ConsolidationStore = Pick<
  MemoryBackend,
  "getViewer" | "listNotes" | "listDeletions" | "dirtyViewerKeys" | "commitViewer" | "purgeSoftDeletions" | "withConsolidationLock" | "setMeta"
>;

export interface PassDeps {
  store: ConsolidationStore;
  hook: Consolidator;
  cfg: Config["brain"]["memory"];
  log: Logger;
  /** Milliseconds since the epoch. */
  now?: () => number;
  /** Awaited before each viewer: the service holds a pass back while the cortex is busy (MEM-CONSOL-003). */
  gate?: () => Promise<void>;
  /** When aborted, the pass finishes the viewer in progress and stops (MEM-CONSOL-011). */
  signal?: AbortSignal;
}

export interface PassResult {
  /** `skipped`: another pass holds the lock. `interrupted`: stopped before every viewer was processed. */
  status: "completed" | "skipped" | "interrupted";
  viewers: number;
  notes: number;
}

// @spec MEM-CONSOL-010, MEM-CONSOL-011, MEM-CONSOL-014, MEM-CONSOL-016
/**
 * One consolidation pass over every viewer with a dirty note. Throws if a viewer cannot be processed (the viewers committed
 * before it stay committed and the rest stay dirty); a model failure is not an error, the hook's rules fallback proposes nothing.
 */
export async function runConsolidation(deps: PassDeps): Promise<PassResult> {
  const { store, cfg, log, signal } = deps;
  const clock = deps.now ?? Date.now;
  const locked = await store.withConsolidationLock(async (): Promise<PassResult> => {
    const keys = await store.dirtyViewerKeys();
    let viewers = 0, notes = 0;
    for (const key of keys) {
      if (signal?.aborted) return { status: "interrupted", viewers, notes };
      await deps.gate?.();
      if (signal?.aborted) return { status: "interrupted", viewers, notes };
      const processed = await consolidateViewer(deps, key, clock());
      if (processed > 0) { viewers++; notes += processed; }
    }
    const at = new Date(clock());
    await store.setMeta(META_LAST_CONSOLIDATION, JSON.stringify({ at: at.toISOString(), viewers, notes }));
    const purged = await store.purgeSoftDeletions(new Date(clock() - cfg.notes.deleted_retention_days * 86_400_000));
    log.info({ viewers, notes, purged }, "consolidation pass complete");
    return { status: "completed", viewers, notes };
  });
  if (!locked.ran) {
    log.info("consolidation pass skipped: another pass holds the lock");
    return { status: "skipped", viewers: 0, notes: 0 };
  }
  return locked.value;
}

/** A note while a pass works on it: the state it would commit, plus the version it was read at. */
interface Work {
  row: NoteRow;
  layer: Layer;
  category: Category;
  text: string;
  hint: string | null;
  strength: number;
  strengthAt: Date;
  mentions: number;
  changed: boolean;
  deleted: boolean;
  absorbed: Work[];
  consumed: boolean;
}

// @spec MEM-CONSOL-004
/** Read, fade, suppress, ask the model, commit. Returns how many notes it processed (0 when the viewer had nothing dirty). */
async function consolidateViewer(deps: PassDeps, key: string, nowMs: number): Promise<number> {
  const { store, cfg, log } = deps;
  const cn = cfg.notes;
  const now = new Date(nowMs);
  const notes = await store.listNotes(key);
  if (!notes.some((n) => n.dirty)) return 0;
  const rules = (await store.listDeletions(key)).filter((d): d is DeletionRow & { reason: string } => d.reason !== null);
  const work: Work[] = notes.map((row) => ({
    row, layer: row.layer, category: row.category, text: row.text, hint: row.hint, strength: row.strength,
    strengthAt: row.strengthAt, mentions: row.mentions, changed: false, deleted: false, absorbed: [], consumed: false,
  }));
  const eff = (w: Work) => effectiveStrength(w, now, cn);

  // @spec MEM-NOTE-006, MEM-NOTE-007, MEM-NOTE-008
  for (const w of work) {
    if (w.layer === "core" && eff(w) < cn.demote_below) {
      w.strength = eff(w); w.strengthAt = now; w.layer = "recent"; w.mentions = 0; w.changed = true;
    }
    if (w.layer === "recent" && eff(w) < cn.drop_below) { w.deleted = true; continue; }
    if (w.layer === "recent" && w.mentions >= cn.promote_mentions) { w.layer = "core"; w.changed = true; }
  }

  // @spec MEM-CONSOL-009
  for (const w of work) {
    if (!w.deleted && rules.some((r) => cosine(w.row.embedding, r.embedding) >= cn.suppress_similarity)) w.deleted = true;
  }

  const live = work.filter((w) => !w.deleted);
  if (live.length > 0) {
    const input: ConsolidatorInput = {
      viewer: (await store.getViewer(key))?.display ?? key,
      notes: live.map((w) => ({ id: w.row.id, layer: w.layer, category: w.category, text: w.text, hint: w.hint, strength: eff(w), mentions: w.mentions })),
      suppressionReasons: rules.map((r) => r.reason),
    };
    let ops: ConsolidatorOp[] = [];
    try {
      // The hook already validates; this guards a hook that does not, so no operation can name a note it was not given.
      ops = validateOps((await deps.hook.run(input)).ops, new Set(live.map((w) => w.row.id)))?.ops ?? [];
    } catch (err) {
      log.warn({ err: String(err), viewer: key }, "consolidator failed; applying the arithmetic only");
    }
    applyOps(live, ops, cfg.notes, now);
  }

  const out: NoteOp[] = [];
  for (const w of work) {
    const { row } = w;
    if (w.consumed && !w.deleted) continue; // absorbed into a merge winner, deleted with it
    if (w.deleted) out.push({ kind: "delete", id: row.id, version: row.version });
    else if (w.changed) {
      const set: NoteChange = {
        layer: w.layer, category: w.category, text: w.text, hint: withDefaultHint(w.category, w.hint) ?? null,
        strength: w.strength, strengthAt: w.strengthAt, mentions: w.mentions,
      };
      out.push({ kind: "update", id: row.id, version: row.version, set, ...(w.absorbed.length ? { absorb: w.absorbed.map((m) => ({ id: m.row.id, version: m.row.version })) } : {}) });
    } else out.push({ kind: "clean", id: row.id, version: row.version });
  }
  await store.commitViewer(key, out);
  return notes.length;
}

// @spec MEM-CONSOL-005, MEM-CONSOL-006
/** Apply the model's operations in order to the working notes; an operation naming a note an earlier one consumed is skipped. */
function applyOps(live: Work[], ops: ConsolidatorOp[], cn: Config["brain"]["memory"]["notes"], now: Date): void {
  const byId = new Map(live.map((w) => [w.row.id, w]));
  const free = (id: number): Work | undefined => { const w = byId.get(id); return w && !w.consumed ? w : undefined; };
  for (const op of ops) {
    if (op.op === "drop") {
      const w = free(op.id);
      if (w) { w.deleted = true; w.consumed = true; }
    } else if (op.op === "rewrite") {
      const w = free(op.id);
      if (!w) continue;
      if (op.text !== undefined) w.text = op.text;
      if (op.category !== undefined) w.category = op.category;
      if (op.hint !== undefined) w.hint = op.hint;
      w.hint = withDefaultHint(w.category, w.hint) ?? null;
      w.changed = true;
    } else {
      const members = op.ids.map(free);
      if (members.some((m) => !m)) continue;
      const ms = members as Work[];
      const strongest = ms.reduce((best, m) => (effectiveStrength(m, now, cn) > effectiveStrength(best, now, cn) ? m : best));
      let strength = effectiveStrength(strongest, now, cn);
      for (let i = 1; i < ms.length; i++) strength = reinforcedStrength(strength, cn);
      // A merge never makes a sensitive note less sensitive: with no category given, a sensitive member's category wins.
      const category = op.category ?? ms.find((m) => m.category !== "general")?.category ?? strongest.category;
      strongest.text = op.text;
      strongest.category = category;
      strongest.hint = withDefaultHint(category, op.hint ?? ms.find((m) => m.category === category && m.hint)?.hint) ?? null;
      strongest.layer = ms.some((m) => m.layer === "core") ? "core" : "recent";
      strongest.mentions = ms.reduce((n, m) => n + m.mentions, 0);
      strongest.strength = strength;
      strongest.strengthAt = now;
      strongest.changed = true;
      for (const m of ms) {
        if (m === strongest) continue;
        m.consumed = true;
        strongest.absorbed.push(m);
      }
    }
  }
}
