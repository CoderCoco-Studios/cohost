/**
 * The repetition check: a deterministic comparison of a reply with what the co-host said recently. It uses no model
 * and performs no I/O; the caller supplies the recent lines and the threshold.
 */

/** One recent `self` line: its own text, what the audience heard of it, and the fallback text that played in its place. */
export interface RecentLine {
  text: string;
  heard?: string;
  fallback?: string;
}

const WORD_CHAR = "[\\p{L}\\p{M}\\p{N}]";
/** An apostrophe between two word characters: removed, so it neither splits nor joins words. */
const INNER_APOSTROPHE = new RegExp(`(?<=${WORD_CHAR})['’](?=${WORD_CHAR})`, "gu");
const WORD = new RegExp(`${WORD_CHAR}+`, "gu");

// @spec CTX-REPEAT-005
/** The distinct words of a line: lower-cased with no locale, inner apostrophes removed, then the maximal runs of letters, marks and digits. */
function wordSet(line: string): Set<string> {
  const cleaned = line.toLowerCase().replace(INNER_APOSTROPHE, "");
  return new Set(cleaned.match(WORD) ?? []);
}

// @spec CTX-REPEAT-006, CTX-REPEAT-007, CTX-REPEAT-008
/** The similarity of two word sets: 1 for a short line that matches word for word, else the shared share of the union. */
function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  if (a.size < 3 || b.size < 3) {
    if (a.size !== b.size) return 0;
    for (const w of a) if (!b.has(w)) return 0;
    return 1;
  }
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / (a.size + b.size - shared);
}

/** A repeat: how alike the reply is to the recent line it matched, and that line's text. */
export interface RepeatMatch { score: number; said: string }

// @spec CTX-REPEAT-003, CTX-REPEAT-004, CTX-REPEAT-009, CTX-REPEAT-014, CTX-REPEAT-015
/**
 * The most alike recent line at or above `threshold`, or undefined. A recent line is compared by its heard text, else its
 * fallback text, else its text; a heard text that is empty leaves the line out. A threshold of 0 (or anything not above 0)
 * runs no check.
 */
export function repeatMatch(reply: string, recent: readonly RecentLine[], threshold: number): RepeatMatch | undefined {
  if (!(threshold > 0)) return undefined;
  const replySet = wordSet(reply);
  let best: RepeatMatch | undefined;
  for (const line of recent) {
    if (line.heard === "") continue;
    const said = line.heard ?? line.fallback ?? line.text;
    const score = similarity(replySet, wordSet(said));
    if (score >= threshold && (best === undefined || score > best.score)) best = { score, said };
  }
  return best;
}

/** True when `reply` repeats one of `recent` (see `repeatMatch`). */
export function isRepeat(reply: string, recent: readonly RecentLine[], threshold: number): boolean {
  return repeatMatch(reply, recent, threshold) !== undefined;
}
