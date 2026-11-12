/**
 * The settings editor's engine: reads a section of `config.yaml` as a list of keys with their source, and writes edited
 * values back into the file text in place (every byte outside the edited values is left as the owner wrote it). The
 * dashboard routes (module-contract MOD-CFG-*) are thin wrappers over this module.
 */
import { createHash } from "node:crypto";
import { parse as parseYaml, parseDocument, isMap, isScalar, isSeq, stringify, type Document, type YAMLMap } from "yaml";
import type { ZodTypeAny } from "zod";
import { ConfigSchema, SECRET_PATHS } from "./schema.js";
import { parseConfigText, substituteEnv, coerceEmptyNumbers, type ConfigIssue } from "./pipeline.js";

type Json = Record<string, unknown>;
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

// ---------- schema introspection (the schema is the form)

/** Strips defaults, optionals, preprocess/refine wrappers; returns the inner type and the nearest description. */
function unwrap(s: ZodTypeAny): { schema: ZodTypeAny; description?: string } {
  let description = s.description;
  for (;;) {
    const d = s._def as { typeName: string; schema?: ZodTypeAny; innerType?: ZodTypeAny; type?: ZodTypeAny };
    const next = d.typeName === "ZodEffects" ? d.schema : d.typeName === "ZodBranded" ? d.type : d.innerType;
    if (!next) return { schema: s, description };
    s = next;
    description ??= s.description;
  }
}

const typeName = (s: ZodTypeAny): string => (s._def as { typeName: string }).typeName;
const shapeOf = (s: ZodTypeAny): Record<string, ZodTypeAny> => (s as unknown as { shape: Record<string, ZodTypeAny> }).shape;

/** The zod schema at a dotted path of `ConfigSchema` (e.g. `brain.salience`), or undefined when there is no such path. */
// @spec MOD-CFG-001, MOD-MAN-008
export function schemaAt(path: string): ZodTypeAny | undefined {
  let cur: ZodTypeAny = ConfigSchema;
  for (const seg of path.split(".")) {
    const u = unwrap(cur).schema;
    if (typeName(u) !== "ZodObject") return undefined;
    const next = shapeOf(u)[seg];
    if (!next) return undefined;
    cur = next;
  }
  return cur;
}

function jsonSchemaOf(s: ZodTypeAny, path: string[]): Json {
  const { schema: u, description } = unwrap(s);
  const out: Json = {};
  const checks = ((u._def as { checks?: { kind: string; value?: number; inclusive?: boolean }[] }).checks) ?? [];
  switch (typeName(u)) {
    case "ZodObject": {
      const properties: Json = {};
      const required: string[] = [];
      for (const [k, v] of Object.entries(shapeOf(u))) {
        properties[k] = jsonSchemaOf(v, [...path, k]);
        if (!v.safeParse(undefined).success) required.push(k);
      }
      out.type = "object";
      out.properties = properties;
      if (required.length) out.required = required;
      break;
    }
    case "ZodString":
      out.type = "string";
      for (const c of checks) {
        if (c.kind === "min") out.minLength = c.value;
        if (c.kind === "max") out.maxLength = c.value;
      }
      break;
    case "ZodNumber":
      out.type = checks.some((c) => c.kind === "int") ? "integer" : "number";
      for (const c of checks) {
        if (c.kind === "min") out[c.inclusive ? "minimum" : "exclusiveMinimum"] = c.value;
        if (c.kind === "max") out[c.inclusive ? "maximum" : "exclusiveMaximum"] = c.value;
      }
      break;
    case "ZodBoolean": out.type = "boolean"; break;
    case "ZodEnum": out.type = "string"; out.enum = (u._def as { values: string[] }).values; break;
    case "ZodArray": {
      out.type = "array";
      out.items = jsonSchemaOf((u._def as { type: ZodTypeAny }).type, path);
      const min = (u._def as { minLength?: { value: number } | null }).minLength;
      if (min) out.minItems = min.value;
      break;
    }
    case "ZodRecord": out.type = "object"; out.additionalProperties = jsonSchemaOf((u._def as { valueType: ZodTypeAny }).valueType, path); break;
    default: break; // any, unknown: no constraint
  }
  const d = s.safeParse(undefined);
  if (d.success && d.data !== undefined && !isObj(d.data)) out.default = d.data;
  if (description) out.description = description;
  if (SECRET_PATHS.includes(path.join("."))) out["x-secret"] = true;
  return out;
}

/** JSON Schema for the section at `section`, generated from its zod schema; secret keys carry `"x-secret": true`. */
// @spec MOD-CFG-001, MOD-CFG-002
export function sectionJsonSchema(section: string): Json {
  const s = schemaAt(section);
  if (!s) throw new Error(`no such config section: ${section}`);
  return jsonSchemaOf(s, section.split("."));
}

interface Leaf { key: string; path: string[]; schema: ZodTypeAny; secret: boolean }

/** The keys of a section: every scalar or array under it, named by its dotted path relative to the section (a leaf section is named for itself). */
function leavesOf(section: string): Leaf[] {
  const segs = section.split(".");
  const root = schemaAt(section);
  if (!root) throw new Error(`no such config section: ${section}`);
  const out: Leaf[] = [];
  const walk = (s: ZodTypeAny, rel: string[]): void => {
    const u = unwrap(s).schema;
    if (typeName(u) === "ZodObject") { for (const [k, v] of Object.entries(shapeOf(u))) walk(v, [...rel, k]); return; }
    const path = [...segs, ...rel];
    out.push({ key: rel.length ? rel.join(".") : segs[segs.length - 1]!, path, schema: s, secret: SECRET_PATHS.includes(path.join(".")) });
  };
  walk(root, []);
  return out;
}

/** The secret keys of a section, relative to the section like the keys of `readSection`. */
// @spec MOD-CFG-002
export function sectionSecrets(section: string): string[] {
  return leavesOf(section).filter((l) => l.secret).map((l) => l.key);
}

function unknownBySchema(raw: unknown, schema: ZodTypeAny, path: string): string[] {
  const u = unwrap(schema).schema;
  const t = typeName(u);
  if (t === "ZodObject" && isObj(raw)) {
    const shape = shapeOf(u);
    return Object.entries(raw).flatMap(([k, v]) => {
      const here = `${path}.${k}`;
      return k in shape ? unknownBySchema(v, shape[k]!, here) : [here];
    });
  }
  if (t === "ZodArray" && Array.isArray(raw)) {
    return raw.flatMap((v, i) => unknownBySchema(v, (u._def as { type: ZodTypeAny }).type, `${path}[${i}]`));
  }
  return [];
}

// ---------- reading

export type KeySource = "literal" | "env" | "env-default" | "default" | "composite";

export interface KeyInfo {
  source: KeySource;
  editable: boolean;
  /** The effective value (substituted, schema defaults applied). Absent for a secret. */
  value?: unknown;
  /** The file text (`literal`, `composite`) or the default part of the placeholder (`env-default`). Absent for a secret. */
  raw?: string;
  env?: { name: string; set: boolean };
  /** Present (true) only on a secret key, with `set` saying whether its effective value is non-empty. */
  secret?: true;
  set?: boolean;
}

export interface SectionRead { keys: Record<string, KeyInfo>; unknown: string[] }

/** SHA-256 hex of the file text. */
// @spec MOD-CFG-003
export const etagOf = (text: string): string => createHash("sha256").update(text).digest("hex");

const PLACEHOLDER = /\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/;
const getPath = (root: unknown, path: string[]): unknown => path.reduce<unknown>((o, k) => (isObj(o) ? o[k] : undefined), root);
const envSet = (env: NodeJS.ProcessEnv, name: string): boolean => env[name] !== undefined && env[name] !== "";
const sliceOf = (text: string, node: { range?: [number, number, number] | null }): string => (node.range ? text.slice(node.range[0], node.range[1]) : "");

interface Classified { source: KeySource; raw?: string; env?: { name: string; set: boolean } }

function classify(text: string, doc: Document, node: unknown, env: NodeJS.ProcessEnv): Classified {
  if (node === undefined || node === null) return { source: "default" };
  const n = node as { range?: [number, number, number] | null };
  if (isScalar(node) && typeof node.value === "string") {
    const full = /^\$\{([A-Z0-9_]+)\}$/.exec(node.value);
    if (full) return { source: "env", env: { name: full[1]!, set: envSet(env, full[1]!) } };
    const withDef = /^\$\{([A-Z0-9_]+):-([^}]*)\}$/.exec(node.value);
    if (withDef) return { source: "env-default", raw: withDef[2]!, env: { name: withDef[1]!, set: envSet(env, withDef[1]!) } };
    if (PLACEHOLDER.test(node.value)) return { source: "composite", raw: sliceOf(text, n) };
    return { source: "literal", raw: sliceOf(text, n) };
  }
  if (isSeq(node) || isMap(node)) {
    return { source: PLACEHOLDER.test(JSON.stringify(node.toJS(doc) ?? null)) ? "composite" : "literal", raw: sliceOf(text, n) };
  }
  return { source: "literal", raw: sliceOf(text, n) };
}

/** Reads one section of the file text: each key's source and effective value, and the keys the schema does not know. */
// @spec MOD-CFG-004, MOD-CFG-005, MOD-CFG-006
export function readSection(text: string, section: string, env: NodeJS.ProcessEnv = process.env): SectionRead {
  const leaves = leavesOf(section);
  const doc = parseDocument(text);
  const parsed = parseConfigText(text, env);
  const effective: unknown = parsed.ok ? parsed.config : parsed.raw;
  const keys: Record<string, KeyInfo> = {};
  for (const leaf of leaves) {
    const c = classify(text, doc, doc.getIn(leaf.path, true), env);
    const value = getPath(effective, leaf.path);
    if (leaf.secret) {
      const set = typeof value === "string" ? value !== "" : value !== undefined && value !== null;
      keys[leaf.key] = { source: c.source, editable: false, secret: true, set, ...(c.env ? { env: c.env } : {}) };
      continue;
    }
    keys[leaf.key] = {
      source: c.source,
      editable: c.source === "literal" || c.source === "default" || c.source === "env-default",
      ...(value !== undefined ? { value } : {}),
      ...(c.raw !== undefined ? { raw: c.raw } : {}),
      ...(c.env ? { env: c.env } : {}),
    };
  }
  const segs = section.split(".");
  const rawTree = doc.errors.length ? undefined : getPath(doc.toJS(), segs);
  return { keys, unknown: rawTree === undefined ? [] : unknownBySchema(rawTree, schemaAt(section)!, section) };
}

// ---------- writing

export type ApplyResult = { ok: true; text: string; warnings: string[] } | { ok: false; issues: ConfigIssue[] };

/** One YAML scalar or collection as text, never folded and never multi-line for a scalar. */
function dump(value: unknown, flow = false): string {
  if (typeof value === "string" && /[\r\n]/.test(value)) return JSON.stringify(value);
  return stringify(value, { lineWidth: 0, ...(flow ? { collectionStyle: "flow" as const } : {}) }).replace(/\n+$/, "");
}

const lineStart = (text: string, pos: number): number => text.lastIndexOf("\n", pos - 1) + 1;
const columnOf = (text: string, pos: number): number => pos - lineStart(text, pos);
const indentLines = (block: string, n: number): string => block.split("\n").map((l) => " ".repeat(n) + l).join("\n");

/** Nests `value` under the remaining path segments: `["a","b"]` and 3 give `{ a: { b: 3 } }`. */
const nest = (rest: string[], value: unknown): unknown => rest.reduceRight<unknown>((acc, k) => ({ [k]: acc }), value);

/** The end of the last line of a node's content (before the newline), so a new line goes after any trailing comment. */
function endOfContentLine(text: string, end: number): number {
  let pos = end;
  while (pos > 0 && text[pos - 1] === "\n") pos--;
  const nl = text.indexOf("\n", pos);
  return nl === -1 ? text.length : nl;
}

function quoteLike(value: string, type: string | undefined): string {
  if (/[\r\n]/.test(value)) return JSON.stringify(value);
  if (type === "QUOTE_DOUBLE") return JSON.stringify(value);
  if (type === "QUOTE_SINGLE") return `'${value.replace(/'/g, "''")}'`;
  return dump(value);
}

/** Replaces the existing node at `path` with `value`, keeping the quote style of a replaced string. */
function replaceNode(text: string, doc: Document, path: string[], value: unknown): string {
  const node = doc.getIn(path, true) as { range?: [number, number, number] | null; type?: string; flow?: boolean } | undefined;
  if (!node?.range) throw new Error(`no node at ${path.join(".")}`);
  const start = node.range[0];
  let end = node.range[1];
  while (end > start && /\s/.test(text[end - 1]!)) end--; // a block collection's range runs through its trailing newline
  let next: string;
  if (isScalar(node)) {
    next = typeof value === "string" ? quoteLike(value, node.type) : Array.isArray(value) || isObj(value) ? dump(value, true) : dump(value);
  } else if (node.flow) {
    next = dump(value, true);
  } else if (Array.isArray(value) && value.length > 0) {
    next = dump(value).split("\n").map((l, i) => (i === 0 ? l : " ".repeat(columnOf(text, start)) + l)).join("\n");
  } else {
    next = dump(value, true);
  }
  return text.slice(0, start) + next + text.slice(end);
}

/** Adds `path` = `value` to the file: into the deepest existing mapping, or at the end of the file when no section exists. */
function insertKey(text: string, doc: Document, path: string[], value: unknown): string {
  let depth = 0;
  let parent: YAMLMap | undefined = isMap(doc.contents) ? doc.contents : undefined;
  for (let i = 1; i < path.length; i++) {
    const n = doc.getIn(path.slice(0, i), true);
    if (!isMap(n)) break;
    parent = n;
    depth = i;
  }
  const rest = path.slice(depth);
  if (!parent) return `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${dump(nest(rest, value))}\n`;
  const existing = parent.items.find((p) => isScalar(p.key) && p.key.value === rest[0]);
  if (existing) {
    // The key is there with no value (`brain:`): its children go on the lines below it.
    const k = existing.key as { range: [number, number, number] };
    if (existing.value && !(isScalar(existing.value) && existing.value.value === null)) throw new Error(`${path.slice(0, depth + 1).join(".")} is not a mapping`);
    const col = columnOf(text, k.range[0]);
    const at = endOfContentLine(text, k.range[1]);
    return `${text.slice(0, at)}\n${indentLines(dump(nest(rest.slice(1), value)), col + 2)}${text.slice(at)}`;
  }
  const last = parent.items[parent.items.length - 1];
  if (parent.flow) {
    const whole = dump({ [rest[0]!]: nest(rest.slice(1), value) }, true); // `{ a: 1 }`
    const inner = whole.replace(/^\{\s*/, "").replace(/\s*\}$/, "");
    if (!last) { const r = parent.range!; return `${text.slice(0, r[0])}{ ${inner} }${text.slice(r[1])}`; }
    const lastNode = (last.value ?? last.key) as { range: [number, number, number] };
    return `${text.slice(0, lastNode.range[1])}, ${inner}${text.slice(lastNode.range[1])}`;
  }
  const firstKey = parent.items[0]!.key as { range: [number, number, number] };
  const col = columnOf(text, firstKey.range[0]);
  const lastNode = (last!.value ?? last!.key) as { range: [number, number, number] };
  const at = endOfContentLine(text, lastNode.range[1]);
  return `${text.slice(0, at)}\n${indentLines(dump(nest(rest, value)), col)}${text.slice(at)}`;
}

const sameValue = (a: unknown, b: unknown): boolean =>
  typeof a === "object" || typeof b === "object" ? JSON.stringify(a) === JSON.stringify(b) : String(a) === String(b);

/**
 * Applies `values` (key of the section to new value) to the file text and validates the result with the loader's pipeline.
 * Returns the edited text and warnings, or the issues that stopped it (the text is never partly edited).
 */
// @spec MOD-CFG-009, MOD-CFG-010, MOD-CFG-011, MOD-CFG-012
export function applySection(text: string, section: string, values: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): ApplyResult {
  const info = readSection(text, section, env).keys;
  const leaves = new Map(leavesOf(section).map((l) => [l.key, l]));
  const issues: ConfigIssue[] = [];
  for (const key of Object.keys(values)) {
    const k = info[key];
    if (!k) issues.push({ path: key, message: `not a key of section ${section}` });
    else if (!k.editable) issues.push({ path: key, message: k.secret ? "a secret; set it in .env" : k.source === "env" ? `set by ${k.env?.name} in .env` : "mixes text and placeholders; edit config.yaml by hand" });
  }
  if (issues.length) return { ok: false, issues };

  let out = text;
  const edited: { leaf: Leaf; value: unknown; envName?: string }[] = [];
  for (const [key, value] of Object.entries(values)) {
    const leaf = leaves.get(key)!;
    const k = info[key]!;
    try {
      const doc = parseDocument(out);
      if (value === null || value === undefined) { issues.push({ path: key, message: "a value is required" }); continue; }
      if (k.source === "env-default") {
        const def = String(value);
        if (/[}\r\n]/.test(def)) { issues.push({ path: key, message: "a default inside ${VAR:-...} cannot contain } or a line break" }); continue; }
        const node = doc.getIn(leaf.path, true) as { range: [number, number, number]; type?: string };
        const esc = node.type === "QUOTE_DOUBLE" ? def.replace(/\\/g, "\\\\").replace(/"/g, '\\"') : node.type === "QUOTE_SINGLE" ? def.replace(/'/g, "''") : def;
        const src = out.slice(node.range[0], node.range[1]).replace(/(\$\{[A-Z0-9_]+:-)[^}]*\}/, (_, head: string) => `${head}${esc}}`);
        out = out.slice(0, node.range[0]) + src + out.slice(node.range[1]);
        edited.push({ leaf, value, envName: k.env!.name });
      } else {
        if (typeof value === "string" && PLACEHOLDER.test(value)) { issues.push({ path: key, message: "a value cannot contain ${...}; placeholders are written by hand in config.yaml" }); continue; }
        out = k.source === "literal" ? replaceNode(out, doc, leaf.path, value) : insertKey(out, doc, leaf.path, value);
        edited.push({ leaf, value });
      }
    } catch (e) {
      issues.push({ path: key, message: (e as Error).message });
    }
  }
  if (issues.length) return { ok: false, issues };

  const valid = parseConfigText(out, env);
  if (!valid.ok) return { ok: false, issues: valid.issues };

  // The written text must read back as what was asked for (a quote or comment character can change a value).
  const warnings: string[] = [];
  for (const e of edited) {
    const without = { ...env };
    if (e.envName) delete without[e.envName];
    const back = getPath(coerceEmptyNumbers(parseYaml(substituteEnv(out, without))), e.leaf.path);
    if (!sameValue(back, e.value)) issues.push({ path: e.leaf.key, message: "that value cannot be written to config.yaml as given" });
    if (e.envName && envSet(env, e.envName)) warnings.push(`${e.leaf.path.join(".")}: ${e.envName} is set in the environment, so the new default is shadowed until it is unset`);
  }
  if (issues.length) return { ok: false, issues };
  return { ok: true, text: out, warnings };
}
