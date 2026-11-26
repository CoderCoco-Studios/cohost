// The UI build's third-party notices (DEPLOY-LIC-005 to DEPLOY-LIC-007): the pure part of the Vite plugin in vite.config.ts,
// which takes the bundled packages as data. Node-only: it hashes the file it writes, and nothing of it reaches a page.
import { createHash } from "node:crypto";

/** The SPDX identifiers the owner allows in a bundled package (DEPLOY-LIC-006). */
export const ALLOWED_LICENCES: ReadonlySet<string> = new Set([
  "MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "0BSD", "CC0-1.0", "Unlicense", "Zlib", "BlueOak-1.0.0",
]);

/** A file of a package's root that holds its licence: `LICENSE`, `LICENCE`, `COPYING` or `NOTICE`, with an optional `-SUFFIX` and a text extension (DEPLOY-LIC-007). */
const LICENCE_FILE = /^(?:LICEN[CS]E|COPYING|NOTICE)(?:-[A-Za-z0-9][A-Za-z0-9-]*)?(?:\.(?:md|markdown|txt))?$/i;

/** True for a file name in a package root that is a licence file. A path, a directory or another extension is not. */
// @spec DEPLOY-LIC-007
export function isLicenceFile(name: string): boolean {
  return LICENCE_FILE.test(name);
}

/**
 * The licence expression a manifest declares: its `license` string, or the `type` of a `license` object. The legacy
 * `licenses` array is read as an AND of its entries, so it is allowed only when every entry is (fails closed). A manifest
 * with no usable entry has none.
 */
// @spec DEPLOY-LIC-006
export function manifestLicence(m: { license?: unknown; licenses?: unknown }): string | undefined {
  if (typeof m.license === "string") return m.license;
  if (typeof m.license === "object" && m.license !== null && typeof (m.license as { type?: unknown }).type === "string") return (m.license as { type: string }).type;
  if (Array.isArray(m.licenses) && m.licenses.length > 0) {
    const types = m.licenses.map((l) => (typeof l === "object" && l !== null && typeof (l as { type?: unknown }).type === "string" ? (l as { type: string }).type : null));
    if (types.every((t): t is string => t !== null)) return types.join(" AND ");
  }
  return undefined;
}

/** A bundled package as the plugin reads it: its manifest fields, whether it sits in the workspace, and its root's licence files. */
export interface BundledPackage {
  name: string;
  version: string;
  license: string | undefined;
  workspace: boolean;
  files: { name: string; text: string }[];
}

// An SPDX expression as the packages here write it: identifiers, parentheses, AND and OR (AND binds tighter). Anything else is malformed.
const TOKEN = /\s*(\(|\)|(?:AND|OR)(?![A-Za-z0-9.+-])|[A-Za-z0-9][A-Za-z0-9.+-]*)/y;

/** True when the expression is a well-formed SPDX expression of the allowed identifiers, an OR needing one allowed part and an AND every part. */
// @spec DEPLOY-LIC-006
export function licenceAllowed(expr: string | undefined | null): boolean {
  if (typeof expr !== "string") return false;
  const tokens: string[] = [];
  TOKEN.lastIndex = 0;
  let pos = 0;
  while (pos < expr.length) {
    if (/^\s*$/.test(expr.slice(pos))) break;
    TOKEN.lastIndex = pos;
    const m = TOKEN.exec(expr);
    if (m === null) return false;
    tokens.push(m[1]!);
    pos = TOKEN.lastIndex;
  }
  if (tokens.length === 0) return false;
  let i = 0;
  const factor = (): boolean | null => {
    const t = tokens[i++];
    if (t === undefined) return null;
    if (t === "(") {
      const v = orExpr();
      if (v === null || tokens[i++] !== ")") return null;
      return v;
    }
    if (t === ")" || t === "AND" || t === "OR") return null;
    return ALLOWED_LICENCES.has(t);
  };
  const andExpr = (): boolean | null => {
    let v = factor();
    while (v !== null && tokens[i] === "AND") {
      i++;
      const r = factor();
      if (r === null) return null;
      v = v && r;
    }
    return v;
  };
  const orExpr = (): boolean | null => {
    let v = andExpr();
    while (v !== null && tokens[i] === "OR") {
      i++;
      const r = andExpr();
      if (r === null) return null;
      v = v || r;
    }
    return v;
  };
  const result = orExpr();
  return result === true && i === tokens.length;
}

/** The notices file's name and text, the hash of the text in the name so a changed file has a new name (DEPLOY-LIC-005). */
export interface Notices { text: string; fileName: string }

/**
 * The notices for the bundled third-party packages (DEPLOY-LIC-005): one entry per name and version, sorted, with the
 * licence expression and the full text of each licence file. A workspace package has no entry and no check. A package
 * whose licence no allowed identifier satisfies, that has no licence expression, or that has no non-empty licence file,
 * makes this throw, naming the package (DEPLOY-LIC-006, DEPLOY-LIC-007).
 */
// @spec DEPLOY-LIC-005, DEPLOY-LIC-006, DEPLOY-LIC-007
export function buildNotices(packages: readonly BundledPackage[]): Notices {
  const entries = new Map<string, BundledPackage>();
  for (const p of packages) {
    if (p.workspace) continue;
    const id = `${p.name}@${p.version}`;
    if (!licenceAllowed(p.license)) {
      throw new Error(`${id}: licence ${p.license === undefined || p.license === "" ? "(none)" : JSON.stringify(p.license)} is not one the UI build allows`);
    }
    const licences = p.files.filter((f) => isLicenceFile(f.name) && f.text.trim() !== "");
    if (licences.length === 0) throw new Error(`${id}: no licence file (LICENSE, LICENCE, COPYING or NOTICE) with text`);
    entries.set(id, { ...p, files: licences });
  }
  const sections = [...entries.keys()].toSorted().map((id) => {
    const p = entries.get(id)!;
    const files = p.files.map((f) => `--- ${f.name} ---\n${f.text.trimEnd()}\n`).join("\n");
    return `${id}\nLicence: ${p.license}\n\n${files}`;
  });
  const text = ["Third-party notices for the cohost dashboard UI.", "", ...sections.map((s) => `${s}\n`)].join("\n");
  const hash = createHash("sha256").update(text).digest("hex").slice(0, 8);
  return { text, fileName: `third-party-notices-${hash}.txt` };
}

/**
 * The string literal the UI source holds for the notices file name (ui/src/app/notices.ts, DASH-AVS-011). The notices plugin
 * replaces the whole literal, quotes included, with the file name as a string in each entry script.
 */
export const NOTICES_SENTINEL = "__COHOST_NOTICES_NAME__";

/**
 * Replaces the sentinel literal in an entry script with the notices file name. Only the literal is replaced: a member access of
 * a name that merely resembles it (the fallback global `globalThis.__COHOST_NOTICES__`), a property key and a longer string stay.
 */
// @spec DASH-AVS-011
export function substituteNoticesName(code: string, fileName: string): string {
  // The minifier may write the literal with any of the three quotes (rolldown emits a template literal). The replacement keeps the
  // quote it matched, so a sentinel inside another string or a tagged template stays a literal of the same kind and still parses.
  let out = code;
  for (const q of ['"', "'", "`"]) out = out.split(`${q}${NOTICES_SENTINEL}${q}`).join(`${q}${fileName}${q}`);
  return out;
}
