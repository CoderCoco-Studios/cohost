import type { NoteData } from "./types";

/** The `brain.memory.notes` figures the strength explainer quotes (read from `GET /config/brain.memory`). */
export interface MemoryFigures {
  recentHalfLifeDays: number;
  coreHalfLifeDays: number;
  promoteMentions: number;
  maxNotesPerViewer: number;
  /** As percentages (0 to 100). */
  dropBelow: number;
  demoteBelow: number;
}

/**
 * The figures from a `GET /config/brain.memory` answer (`keys["notes.recent_half_life_days"].value`, ...), or null when
 * any is missing or not a number, so the explainer leaves figures out rather than quoting some of them (DASH-VIEWERS-022).
 */
// @spec DASH-VIEWERS-022
export function figuresFrom(body: unknown): MemoryFigures | null {
  const keys = (body as { keys?: Record<string, { value?: unknown } | undefined> } | null)?.keys;
  if (!keys || typeof keys !== "object") return null;
  const num = (k: string): number | null => { const v = keys[`notes.${k}`]?.value; return typeof v === "number" && Number.isFinite(v) ? v : null; };
  const r = num("recent_half_life_days"), c = num("core_half_life_days"), p = num("promote_mentions"), m = num("max_notes_per_viewer"), d = num("drop_below"), dm = num("demote_below");
  if (r === null || c === null || p === null || m === null || d === null || dm === null || r <= 0 || c <= 0) return null;
  return { recentHalfLifeDays: r, coreHalfLifeDays: c, promoteMentions: p, maxNotesPerViewer: m, dropBelow: Math.round(d * 100), demoteBelow: Math.round(dm * 100) };
}

export const percentOf = (strength: number): number => Math.round(Math.min(1, Math.max(0, strength)) * 100);

const days = (n: number): string => `${n} ${n === 1 ? "day" : "days"}`;

/**
 * What happens to a note next: a core note halves every `core_half_life_days` days and, below 50% while above the demote
 * threshold, drops to recent under `demote_below`; a recent note is forgotten under `drop_below`, in the days its strength
 * and `recent_half_life_days` give (strength halves every half-life). Empty without the figures (DASH-VIEWERS-011).
 */
// @spec DASH-VIEWERS-011
export function whatNext(n: Pick<NoteData, "layer" | "strength">, f: MemoryFigures | null): string {
  if (!f) return "";
  const p = percentOf(n.strength);
  if (n.layer === "core") {
    const halves = `halves every ${days(f.coreHalfLifeDays)}`;
    return p < 50 && p >= f.demoteBelow ? `${halves}; drops to recent under ${f.demoteBelow}%` : halves;
  }
  const floor = f.dropBelow / 100;
  if (n.strength <= floor) return `forgotten under ${f.dropBelow}%`;
  const left = Math.max(1, Math.round(f.recentHalfLifeDays * Math.log2(n.strength / floor)));
  return `forgotten under ${f.dropBelow}%, in about ${days(left)}`;
}
