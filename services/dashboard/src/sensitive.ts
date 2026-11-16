import { readSection, sectionKeyPaths, sectionPresentation } from "@cohost/config";

/** A submitted value equals the effective one when their text (or JSON, for a structure) is equal: `4455` is `"4455"`. */
const same = (a: unknown, b: unknown): boolean =>
  typeof a === "object" || typeof b === "object" ? JSON.stringify(a) === JSON.stringify(b) : String(a) === String(b);

/** The dotted config path of a section's key, from the name the editor and the presentation use (relative to the section). */
function dottedPath(section: string, key: string): string | undefined {
  const last = section.split(".").pop();
  return sectionKeyPaths(section).find((p) => p === `${section}.${key}` || (p === section && key === last));
}

/**
 * The dotted paths of the keys of `section` that `values` would change and that the presentation table marks `sensitive`: a key
 * is changed when its submitted value differs from its effective value in the file text now (the schema default for a key the
 * file does not hold). A name that is no key of the section is not one; the editor refuses it in its own way.
 */
// @spec DASH-CTRL-009, MOD-CFG-007
export function changedSensitiveKeys(text: string, section: string, values: Readonly<Record<string, unknown>>): string[] {
  const marked = sectionPresentation(section).keys;
  const current = readSection(text, section).keys;
  const out: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (!marked[key]?.sensitive || !current[key]) continue;
    const now = current[key].value;
    const unchanged = value === null || value === undefined ? now === undefined || now === null : same(now, value);
    const path = dottedPath(section, key);
    if (!unchanged && path) out.push(path);
  }
  return out;
}

/** What the 403 says when a sensitive change arrives and no control token is configured at all. */
// @spec DASH-CTRL-010
export const noTokenDetail = (keys: string): string =>
  `changing ${keys} needs the control token, and none is configured: set CONTROL_TOKEN in .env (CONTROL_ENABLED does not have to be 1) and restart the dashboard`;
