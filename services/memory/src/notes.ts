import type { Config } from "@cohost/config";

/** Viewer notes: the record types and the pure arithmetic both stores share. */

export type NotesConfig = Config["brain"]["memory"]["notes"];
export type Layer = "core" | "recent";
export type Category = "general" | "health" | "family";
export const CATEGORIES: readonly Category[] = ["general", "health", "family"];
export const isCategory = (x: unknown): x is Category => typeof x === "string" && (CATEGORIES as readonly string[]).includes(x);

/** A stored viewer note (`viewer_notes` row). */
export interface NoteRow {
  id: number;
  userKey: string;
  layer: Layer;
  category: Category;
  text: string;
  hint: string | null;
  /** Strength as of `strengthAt`; use `effectiveStrength` for "now". */
  strength: number;
  strengthAt: Date;
  mentions: number;
  dirty: boolean;
  version: number;
  createdAt: Date;
  lastSurfacedAt: Date | null;
  embedding: number[];
}

/** An owner-deleted note (`viewer_note_deletions` row). With a reason it is a suppression rule; without, a soft memory. */
export interface DeletionRow {
  id: number;
  userKey: string;
  layer: Layer;
  category: Category;
  text: string;
  hint: string | null;
  strength: number;
  reason: string | null;
  deletedAt: Date;
  embedding: number[];
}

export interface ViewerRow {
  key: string;
  display: string;
  msgCount: number;
  regularManual: boolean;
  isSub: boolean;
  placeholder: boolean;
  firstSeen: Date;
  lastSeen: Date;
  /** `regularManual` or `msgCount` above `brain.memory.regular_messages` (MEM-REG-001). */
  regular: boolean;
}

/** A viewer row with the number of notes stored for it (Viewers page list). */
export interface ViewerSummary extends ViewerRow {
  noteCount: number;
}

export interface NewNote {
  userKey: string;
  layer?: Layer;
  category: Category;
  text: string;
  hint?: string | null;
  strength?: number;
  mentions?: number;
  dirty?: boolean;
  /** The text's embedding when the caller already computed it with the store's embedder (`embedText`), so the store does not embed twice. */
  embedding?: number[];
}

/** One change a consolidation pass wants made to a viewer's notes; it applies only while the note's version is still `version`. */
export type NoteOp =
  /** Rewrite a note (layer move, text, strength...). Clears dirty. `absorb` deletes merged members, only if every version still matches. */
  | { kind: "update"; id: number; version: number; set: NoteChange; absorb?: { id: number; version: number }[] }
  | { kind: "delete"; id: number; version: number }
  /** Processed and unchanged: clear the dirty flag. */
  | { kind: "clean"; id: number; version: number };

export interface NoteChange {
  layer?: Layer;
  category?: Category;
  text?: string;
  hint?: string | null;
  strength?: number;
  strengthAt?: Date;
  mentions?: number;
}

export const MAX_NOTE_TEXT = 120;
export const MAX_NOTE_HINT = 80;

// @spec MEM-NOTE-003
/** 0 for a non-finite or negative value, 1 for a value above 1. */
export function clamp01(x: number): number {
  if (!Number.isFinite(x) || x < 0) return 0;
  return x > 1 ? 1 : x;
}

// @spec MEM-NOTE-002, MEM-NOTE-003
/** Strength at `now`: `strength × 0.5 ^ ((now − strength_at) / half_life(layer))`, clamped. Computed on read, so nothing runs for a note to fade. */
export function effectiveStrength(
  n: { layer: Layer; strength: number; strengthAt: Date },
  now: number | Date,
  cfg: Pick<NotesConfig, "recent_half_life_days" | "core_half_life_days">,
): number {
  const halfLifeMs = (n.layer === "core" ? cfg.core_half_life_days : cfg.recent_half_life_days) * 86_400_000;
  const elapsed = (typeof now === "number" ? now : now.getTime()) - n.strengthAt.getTime();
  return clamp01(n.strength * Math.pow(0.5, elapsed / halfLifeMs));
}

// @spec MEM-NOTE-005
/** `e + (1 − e) × reinforce` for effective strength `e`. */
export function reinforcedStrength(e: number, cfg: Pick<NotesConfig, "reinforce">): number {
  return clamp01(e + (1 - e) * cfg.reinforce);
}

// @spec MEM-NOTE-010
const DEFAULT_HINTS: Partial<Record<Category, string>> = {
  health: "only if they bring it up; never quote it",
  family: "check in warmly and gently; never name or quote it",
};
export const defaultHint = (category: Category): string | undefined => DEFAULT_HINTS[category];

// @spec MEM-NOTE-010
/** The trimmed hint, or the category default when a `health` or `family` note has none. */
export function withDefaultHint(category: Category, hint: string | null | undefined): string | undefined {
  return hint?.trim() || defaultHint(category);
}

// @spec MEM-NOTE-009
const FORBIDDEN_TOPICS: readonly RegExp[] = [
  // politics
  /\b(politic\w*|election|vot(?:e|es|ed|ing)|democrat\w*|republican\w*|liberals?|conservatives?|trump|biden|maga|gop|leftists?|right-wing|left-wing|communis\w*|socialis\w*|fascis\w*|libertarian\w*|abortion|immigration)\b/i,
  // money, wealth and spending
  /\$\s?\d/,
  /\b\d[\d,.]*\s?(?:k|usd|dollars?|bucks|euros?)\b/i,
  /\b(salary|paycheck|income|net worth|wealth|wealthy|rich|millionaire|billionaire|in debt|mortgage|donat(?:e|es|ed|ing|ion|ions))\b/i,
  /\b(?:spen[dt]|spending)\b[^.]*\b(?:money|cash|dollars|bucks)\b/i,
  // subscriber status lives only on the viewer row
  /\b(subs?|subscribers?|subscribed|subscriptions?|resub(?:bed)?)\b/i,
];

/** True when `text` is about the viewer's politics, money or subscriber status: a deterministic backstop to the model prompts, since such a note is never stored. */
export function mentionsForbiddenTopic(text: string): boolean {
  return FORBIDDEN_TOPICS.some((re) => re.test(text));
}

export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}
