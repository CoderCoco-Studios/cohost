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
/** Whether two word sets count as a repeat at this threshold. */
function alike(a: Set<string>, b: Set<string>, threshold: number): boolean {
  if (a.size === 0 && b.size === 0) return false;
  if (a.size < 3 || b.size < 3) {
    if (a.size === 0 || a.size !== b.size) return false;
    for (const w of a) if (!b.has(w)) return false;
    return true;
  }
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  const union = a.size + b.size - shared;
  return shared / union >= threshold;
}

// @spec CTX-REPEAT-003, CTX-REPEAT-004, CTX-REPEAT-009, CTX-REPEAT-014, CTX-REPEAT-015
/**
 * True when `reply` repeats one of `recent`. A recent line is compared by its heard text, else its fallback text, else its
 * text; a heard text that is empty leaves the line out. A threshold of 0 (or anything not above 0) runs no check.
 */
export function isRepeat(reply: string, recent: readonly RecentLine[], threshold: number): boolean {
  if (!(threshold > 0)) return false;
  const replySet = wordSet(reply);
  for (const line of recent) {
    if (line.heard === "") continue;
    const said = line.heard ?? line.fallback ?? line.text;
    if (alike(replySet, wordSet(said), threshold)) return true;
  }
  return false;
}
