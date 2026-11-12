/** Transcript checks shared by live and injected speech: what counts as a word, and the drop-phrase filter. */

const NO_WORD = /^[^\p{L}\p{N}]*$/u;

// @spec EARS-HEAR-006, EARS-HEAR-007
/** True when the text holds a Unicode letter or number in any script (not just ASCII `\w`). */
export function hasWordCharacter(text: string): boolean {
  return !NO_WORD.test(text);
}

/** Lower-case, collapse whitespace, strip leading and trailing non-letter, non-number characters. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

// @spec EARS-HEAR-010
/** True when the whole transcript equals one of `phrases` after both are normalized; an entry that normalizes to nothing never matches. */
export function isDropPhrase(text: string, phrases: readonly string[]): boolean {
  const t = normalize(text);
  return t !== "" && phrases.some((p) => normalize(p) === t);
}
