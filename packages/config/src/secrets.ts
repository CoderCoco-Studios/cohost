import { readFileSync, statSync, realpathSync, lstatSync } from "node:fs";
import { parseDocument, Document, isMap } from "yaml";
import { SECRET_PATHS } from "./schema.js";
import { writeFileAtomic } from "./atomic.js";
import type { SecretValues } from "./pipeline.js";

/** What `secrets.yaml` holds, as `loadConfig` needs it. No field carries text of the file beyond key paths. */
export interface LoadedSecrets {
  /** Each secret path holding a non-empty string. */
  values: SecretValues;
  /** Paths of keys the file holds that are not secret paths, which are ignored. */
  ignored: string[];
  /** True when the file grants any permission to group or other on a platform where that is meaningful. */
  loose: boolean;
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

/** The paths that are a proper prefix of a secret path (`llm`, `llm.openai`, ...): a mapping may sit there. */
const PREFIXES: ReadonlySet<string> = new Set(SECRET_PATHS.flatMap((p) => p.split(".").slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join("."))));

/** The failure of a file the loader or `updateSecrets` cannot use: names the file and a position or a path, never text of the file. */
const invalid = (file: string, lines: string[]): Error => new Error(`Invalid ${file}:\n${lines.map((l) => `  ${l}`).join("\n")}`);

/** Parses the file text; a syntax error is reported by line and column only, because the library's own message quotes the source. */
function parseSecretsText(file: string, text: string): Document {
  const doc = parseDocument(text);
  if (doc.errors.length) {
    const pos = doc.errors[0]!.linePos?.[0];
    throw invalid(file, [`(file): not valid YAML${pos ? ` at line ${pos.line}, column ${pos.col}` : ""}`]);
  }
  return doc;
}

/** Reads `file` as `secrets.yaml`: a missing file holds nothing, one that cannot be read or parsed is an error. */
// @spec CFG-SEC-001, CFG-SEC-002, CFG-SEC-014, CFG-SEC-005, CFG-SEC-006, CFG-SEC-007, CFG-SEC-008, CFG-SEC-010
export function loadSecrets(file: string): LoadedSecrets {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { values: {}, ignored: [], loose: false };
    throw new Error(`Cannot read ${file}: ${code ?? "unknown error"}`);
  }
  const root: unknown = parseSecretsText(file, text).toJS();
  if (root !== null && !isObj(root)) throw invalid(file, ["(file): the root must be a mapping nested like config.yaml"]);

  const values: Record<string, string> = {};
  const ignored: string[] = [];
  const wrong: string[] = [];
  const multiline: string[] = [];
  const walk = (node: Record<string, unknown>, prefix: string): void => {
    for (const [k, v] of Object.entries(node)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (SECRET_PATHS.includes(path)) {
        if (v === null) continue;
        if (typeof v !== "string") { wrong.push(path); continue; }
        const trimmed = v.trim();
        if (trimmed === "") continue;
        if (/[\r\n]/.test(trimmed)) multiline.push(path);
        else values[path] = trimmed;
      } else if (PREFIXES.has(path) && (v === null || isObj(v))) {
        if (v !== null) walk(v, path);
      } else {
        ignored.push(path);
      }
    }
  };
  if (root) walk(root, "");
  if (wrong.length || multiline.length) {
    throw invalid(file, [
      ...wrong.map((p) => `${p}: must be a string (write a value made only of digits in quotes)`),
      ...multiline.map((p) => `${p}: must be a single line`),
    ]);
  }

  const mode = statSync(file).mode & 0o777;
  return { values, ignored, loose: process.platform !== "win32" && mode !== 0o777 && (mode & 0o077) !== 0 };
}

/**
 * Sets or clears secret paths in `file` (`null` clears: the key stays, empty) and replaces the file atomically with mode 0600,
 * keeping every other key and comment. Refuses a path outside `SECRET_PATHS` and a value that is empty after trimming, and
 * applies nothing when any change is refused. Returns nothing and never logs or echoes a value.
 */
// @spec CFG-SEC-009, CFG-SEC-010, CFG-SEC-012, CFG-SEC-013, CFG-SEC-015
export function updateSecrets(linkOrFile: string, changes: Readonly<Record<string, string | null>>): void {
  const next: [string, string][] = [];
  for (const [path, value] of Object.entries(changes)) {
    if (!SECRET_PATHS.includes(path)) throw new Error(`${path} is not a secret key`);
    if (value === null) { next.push([path, ""]); continue; }
    const trimmed = value.trim();
    if (trimmed === "") throw new Error(`${path}: the value is empty after trimming; to remove a credential, clear it`);
    if (/[\r\n]/.test(trimmed)) throw new Error(`${path}: the value must be a single line`);
    next.push([path, trimmed]);
  }
  // A symbolic link is followed: the rename must replace the file it resolves to, or the link would be replaced by a regular file
  // and its target left stale. A link that resolves to nothing is an error, never a file to create.
  let file = linkOrFile;
  let isLink = false;
  try { isLink = lstatSync(linkOrFile).isSymbolicLink(); } catch { /* no such file yet */ }
  if (isLink) {
    try { file = realpathSync(linkOrFile); } catch { throw new Error(`Cannot write ${linkOrFile}: the symbolic link does not resolve to a file`); }
  }
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw new Error(`Cannot read ${file}: ${code ?? "unknown error"}`);
  }
  const doc = text === "" ? new Document({}) : parseSecretsText(file, text);
  if (doc.contents !== null && !isMap(doc.contents)) throw invalid(file, ["(file): the root must be a mapping nested like config.yaml"]);
  for (const [path, value] of next) {
    try {
      doc.setIn(path.split("."), value);
    } catch {
      throw new Error(`Cannot set ${path}: ${file} holds something else at that place`);
    }
  }
  writeFileAtomic(file, doc.toString({ lineWidth: 0 }), { mode: 0o600 });
}
