import { isDeepStrictEqual } from "node:util";
import { applySection, readSection, sectionKeyPaths, sectionPresentation } from "@cohost/config";

/** Strict equality by type and value, structures compared deeply: `"undefined"` is not undefined, `"4455"` is not `4455`. */
export const sameEffective = (a: unknown, b: unknown): boolean => isDeepStrictEqual(a, b);

/**
 * Whether writing `value` to `key` would leave the key's effective value as it is: the edit is applied to the text exactly as a
 * save applies it (the editor's validation, quoting and coercion), and what the result reads back as is compared with the
 * current effective value. A value the editor refuses cannot be written, so it is compared as it stands, by type and value.
 */
function unchangedByWrite(text: string, section: string, key: string, value: unknown, now: unknown): boolean {
  if (value === null || value === undefined) return now === undefined || now === null;
  const edit = applySection(text, section, { [key]: value });
  if (!edit.ok) return sameEffective(now, value);
  return sameEffective(now, readSection(edit.text, section).keys[key]?.value);
}

/** The dotted config path of a section's key, from the name the editor and the presentation use (relative to the section). */
function dottedPath(section: string, key: string): string | undefined {
  const last = section.split(".").pop();
  return sectionKeyPaths(section).find((p) => p === `${section}.${key}` || (p === section && key === last));
}

/**
 * The dotted paths of the keys of `section` that `values` would change and that the presentation table marks `sensitive`: a key
 * is changed when writing its submitted value would change its effective value in the file text now (the schema default for a key
 * the file does not hold): equality is decided on what the write would store, by type and value, never on the values' text. A name that is no key of the section is not one; the editor refuses it in its own way.
 */
// @spec DASH-CTRL-009, MOD-CFG-007
export function changedSensitiveKeys(text: string, section: string, values: Readonly<Record<string, unknown>>): string[] {
  const marked = sectionPresentation(section).keys;
  const current = readSection(text, section).keys;
  const out: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (!marked[key]?.sensitive || !current[key]) continue;
    const now = current[key].value;
    const unchanged = unchangedByWrite(text, section, key, value, now);
    const path = dottedPath(section, key);
    if (!unchanged && path) out.push(path);
  }
  return out;
}

