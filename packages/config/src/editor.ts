/**
 * The settings editor's engine: reads a section of `config.yaml` as a list of keys with their source, and writes edited
 * values back into the file text in place (every byte outside the edited values is left as the owner wrote it). The
 * dashboard routes (module-contract MOD-CFG-*) are thin wrappers over this module.
 */
import { createHash } from "node:crypto";
import { parse as parseYaml, parseDocument, isMap, isScalar, stringify, type Document, type YAMLMap } from "yaml";
import { z } from "zod";
import { ConfigSchema, SECRET_PATHS, secretPathMatches, secretPathOf } from "./schema.js";
import { PRESENTATION, type KeyPresentation, type SectionPresentation } from "./presentation.js";
import { parseConfigText, coerceEmptyNumbers, ISOLATION_OVERRIDES, type ConfigIssue } from "./pipeline.js";

type Json = Record<string, unknown>;
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

// ---------- schema introspection (the schema is the form)

/**
 * Strips defaults, optionals and preprocess wrappers; returns the inner type.
 * Wrappers are recognised by class (`instanceof`), and each exposes the type it wraps as `def.innerType` (a preprocess is a
 * pipe whose input is a transform and whose output is the schema it feeds).
 */
function unwrap(s: z.ZodType): { schema: z.ZodType } {
  for (;;) {
    let next: z.ZodType | undefined;
    if (s instanceof z.ZodPipe) next = (s.def.out instanceof z.ZodTransform ? s.def.in : s.def.out) as z.ZodType;
    else if (s instanceof z.ZodDefault || s instanceof z.ZodPrefault || s instanceof z.ZodOptional || s instanceof z.ZodNullable || s instanceof z.ZodReadonly || s instanceof z.ZodCatch) next = s.def.innerType as z.ZodType;
    if (!next) return { schema: s };
    s = next;
  }
}

const shapeOf = (s: z.ZodObject): Record<string, z.ZodType> => s.shape as Record<string, z.ZodType>;

/** The zod schema at a dotted path of `ConfigSchema` (e.g. `brain.salience`), or undefined when there is no such path. */
// @spec MOD-CFG-001, MOD-MAN-008
export function schemaAt(path: string): z.ZodType | undefined {
  let cur: z.ZodType = ConfigSchema;
  for (const seg of path.split(".")) {
    const u = unwrap(cur).schema;
    if (!(u instanceof z.ZodObject)) return undefined;
    const next = shapeOf(u)[seg];
    if (!next) return undefined;
    cur = next;
  }
  return cur;
}

/**
 * The help of the key at `path` (dotted from the config root) or of a property of an array-of-objects key's items, which
 * the walk reaches as `<array key>.<property>` (CFG-PRES-008, CFG-PRES-009).
 */
function helpAt(path: string[]): string | undefined {
  const dotted = path.join(".");
  const own = PRESENTATION.keys[dotted]?.help;
  if (own !== undefined) return own;
  return PRESENTATION.keys[path.slice(0, -1).join(".")]?.items?.[path[path.length - 1]!]?.help;
}

function jsonSchemaOf(s: z.ZodType, path: string[], element = false): Json {
  const { schema: u } = unwrap(s);
  const out: Json = {};
  // A check's own definition (`_zod.def`) is zod 4's documented way to read a bound and whether it is inclusive.
  const checks = (u._zod.def.checks ?? []).map((c) => c._zod.def as { check: string; value?: number; inclusive?: boolean; minimum?: number; maximum?: number });
  if (u instanceof z.ZodObject) {
    const properties: Json = {};
    const required: string[] = [];
    for (const [k, v] of Object.entries(shapeOf(u))) {
      properties[k] = jsonSchemaOf(v, [...path, k]);
      if (!v.safeParse(undefined).success) required.push(k);
    }
    out.type = "object";
    out.properties = properties;
    if (required.length) out.required = required;
  } else if (u instanceof z.ZodString) {
    out.type = "string";
    for (const c of checks) {
      if (c.check === "min_length") out.minLength = c.minimum;
      if (c.check === "max_length") out.maxLength = c.maximum;
    }
  } else if (u instanceof z.ZodNumber) {
    out.type = u.isInt ? "integer" : "number";
    for (const c of checks) {
      if (c.check === "greater_than") out[c.inclusive ? "minimum" : "exclusiveMinimum"] = c.value;
      if (c.check === "less_than") out[c.inclusive ? "maximum" : "exclusiveMaximum"] = c.value;
    }
  } else if (u instanceof z.ZodBoolean) out.type = "boolean";
  else if (u instanceof z.ZodEnum) { out.type = "string"; out.enum = u.options; }
  else if (u instanceof z.ZodArray) {
    out.type = "array";
    out.items = jsonSchemaOf(u.element as z.ZodType, path, true);
    const min = checks.find((c) => c.check === "min_length")?.minimum;
    if (min) out.minItems = min;
  // a map's entries are described under the key `*`, the wildcard the secret paths use (CFG-SEC-016); the map carries no `type`
  // so that, as a group of keys, it has no description of its own beside its help (CFG-PRES-004)
  } else if (u instanceof z.ZodRecord) out.properties = { "*": jsonSchemaOf(u.valueType as z.ZodType, [...path, "*"]) };
  // any, unknown: no constraint
  const d = s.safeParse(undefined);
  if (d.success && d.data !== undefined && !isObj(d.data)) out.default = d.data;
  // A group of keys has no help of its own: only a leaf (a scalar or an array) is described.
  const description = u instanceof z.ZodObject || element ? undefined : helpAt(path);
  if (description) out.description = description;
  if (!element && secretPathOf(path.join(".")) !== undefined) out["x-secret"] = true;
  if (!element && PRESENTATION.keys[path.join(".")]?.sensitive) out["x-sensitive"] = true;
  return out;
}

/**
 * JSON Schema for the section at `section`, generated from its zod schema; secret keys carry `"x-secret": true`, sensitive
 * keys `"x-sensitive": true`, and each key's `description` is its presentation help.
 */
// @spec MOD-CFG-001, MOD-CFG-002, CFG-PRES-008, CFG-PRES-009, CFG-PRES-010
export function sectionJsonSchema(section: string): Json {
  const s = schemaAt(section);
  if (!s) throw new Error(`no such config section: ${section}`);
  return jsonSchemaOf(s, section.split("."));
}

interface Leaf { key: string; path: string[]; schema: z.ZodType; secret: boolean }

/** The zod schema at a path of object keys below `root`, or undefined when a key is not in an object. */
function leafAt(root: z.ZodType, keys: string[]): z.ZodType | undefined {
  let cur: z.ZodType | undefined = root;
  for (const key of keys) {
    const obj: z.ZodType | undefined = cur ? unwrap(cur).schema : undefined;
    if (!(obj instanceof z.ZodObject)) return undefined;
    cur = shapeOf(obj)[key];
  }
  return cur;
}

/** The keys of a section: every scalar or array under it, named by its dotted path relative to the section (a leaf section is named for itself). */
function leavesOf(section: string): Leaf[] {
  const segs = section.split(".");
  const root = schemaAt(section);
  if (!root) throw new Error(`no such config section: ${section}`);
  const out: Leaf[] = [];
  const walk = (s: z.ZodType, rel: string[]): void => {
    const u = unwrap(s).schema;
    if (u instanceof z.ZodObject) { for (const [k, v] of Object.entries(shapeOf(u))) walk(v, [...rel, k]); return; }
    const path = [...segs, ...rel];
    out.push({ key: rel.length ? rel.join(".") : segs[segs.length - 1]!, path, schema: s, secret: secretPathOf(path.join(".")) !== undefined });
    // the credentials of a map's entries (CFG-SEC-016): `servers.*.token` is a leaf beside the map itself
    if (u instanceof z.ZodRecord) {
      const dotted = path.join(".");
      for (const p of SECRET_PATHS) {
        const parts = p.split(".");
        if (!p.startsWith(`${dotted}.*.`)) continue;
        const rest = parts.slice(path.length + 1);
        const leaf = leafAt(u.valueType as z.ZodType, rest);
        if (leaf) out.push({ key: [...rel, "*", ...rest].join("."), path: parts, schema: leaf, secret: true });
      }
    }
  };
  walk(root, []);
  return out;
}

/** The keys of a section as dotted paths from the config root (a scalar or an array is one key; an array is not descended into). */
// @spec CFG-PRES-001, CFG-PRES-004
export function sectionKeyPaths(section: string): string[] {
  return leavesOf(section).map((l) => l.path.join("."));
}

/** What `GET /config/schema` serves for one section besides its schema: the section's own presentation and each key's, by relative name. */
export interface SectionPresentationJoined extends SectionPresentation {
  keys: Record<string, KeyPresentation>;
}

/**
 * The presentation table joined for one section: `title`, `group`, `about` and, where the table gives one, `page`, plus
 * `keys`, a map from each key's relative name (the names `readSection` uses) to its `{ help, label?, unit?, widget?, items?,
 * sensitive? }`. A key without an entry is left out, so the page falls back to deriving a label from the path.
 */
// @spec MOD-CFG-019, MOD-CFG-020, MOD-CFG-021, CFG-PRES-010
export function sectionPresentation(section: string): SectionPresentationJoined {
  const leaves = leavesOf(section);
  const head = PRESENTATION.sections[section];
  const keys: Record<string, KeyPresentation> = {};
  for (const l of leaves) {
    const k = PRESENTATION.keys[l.path.join(".")];
    if (k) keys[l.key] = structuredClone(k);
  }
  return { ...(head ? structuredClone(head) : ({} as SectionPresentation)), keys };
}

/** The secret keys of a section, relative to the section like the keys of `readSection`. */
// @spec MOD-CFG-002
export function sectionSecrets(section: string): string[] {
  return leavesOf(section).filter((l) => l.secret).map((l) => l.key);
}

function unknownBySchema(raw: unknown, schema: z.ZodType, path: string): string[] {
  const u = unwrap(schema).schema;
  if (u instanceof z.ZodObject && isObj(raw)) {
    const shape = shapeOf(u);
    return Object.entries(raw).flatMap(([k, v]) => {
      const here = `${path}.${k}`;
      return k in shape ? unknownBySchema(v, shape[k]!, here) : [here];
    });
  }
  if (u instanceof z.ZodArray && Array.isArray(raw)) {
    return raw.flatMap((v, i) => unknownBySchema(v, u.element as z.ZodType, `${path}[${i}]`));
  }
  return [];
}

// ---------- reading

/** `literal` when the file holds the key, `default` when it does not (every key is a literal or absent, so there is no other form). */
export type KeySource = "literal" | "default";

export interface KeyInfo {
  /** Absent for a secret. */
  source?: KeySource;
  /** True for every key except a secret. */
  editable: boolean;
  /** The effective value: the file's value or the schema default. Absent for a secret. */
  value?: unknown;
  /** The file text of a `literal` key. Absent for a secret. */
  raw?: string;
  /** Present (true) only on a secret key, with `set` saying whether `secrets.yaml` holds a value for it. */
  secret?: true;
  set?: boolean;
  /** On a key that an isolation override selects: the override's name and the ids of the running units started with it. */
  isolation?: { name: string; overriddenBy: string[] };
}

export interface SectionRead { keys: Record<string, KeyInfo>; unknown: string[] }

/**
 * The running units whose container was started with each isolation override: override name (`ISOLATION_OVERRIDES`) to unit
 * ids. The caller keeps to the units that declare the section; the control plane's stack status is its source.
 */
export type RunningOverrides = Readonly<Record<string, readonly string[]>>;

/** SHA-256 hex of the file text. */
// @spec MOD-CFG-003
export const etagOf = (text: string): string => createHash("sha256").update(text).digest("hex");

const getPath = (root: unknown, path: string[]): unknown => path.reduce<unknown>((o, k) => (isObj(o) ? o[k] : undefined), root);
const sliceOf = (text: string, node: { range?: [number, number, number] | null }): string => (node.range ? text.slice(node.range[0], node.range[1]) : "");

/** The override name whose key is `path`, if one selects it. */
const overrideNameOf = (path: string): string | undefined => Object.entries(ISOLATION_OVERRIDES).find(([, key]) => key === path)?.[0];

/**
 * Reads one section of the file text: each key's source and effective value, the keys the schema does not know, and for each
 * secret only whether `secretsSet` (the secret paths `secrets.yaml` holds, `setSecretPaths()`) names it. `running` says which
 * units run with each isolation override.
 */
// @spec MOD-CFG-004, MOD-CFG-005, MOD-CFG-006, MOD-CFG-018
export function readSection(text: string, section: string, secretsSet: readonly string[] = [], running: RunningOverrides = {}): SectionRead {
  const leaves = leavesOf(section);
  const doc = parseDocument(text);
  const parsed = parseConfigText(text);
  // The parsed tree has the secret paths removed, so a credential pasted into the file is never read back.
  const effective: unknown = parsed.ok ? parsed.config : parsed.raw;
  const keys: Record<string, KeyInfo> = {};
  for (const leaf of leaves) {
    const dotted = leaf.path.join(".");
    if (leaf.secret) {
      keys[leaf.key] = { editable: false, secret: true, set: secretsSet.some((p) => secretPathMatches(p, dotted)) };
      continue;
    }
    const node = doc.getIn(leaf.path, true);
    const present = node !== undefined && node !== null && !(isScalar(node) && node.value === null);
    const value = getPath(effective, leaf.path);
    const name = overrideNameOf(dotted);
    keys[leaf.key] = {
      source: present ? "literal" : "default",
      editable: true,
      ...(value !== undefined ? { value } : {}),
      ...(present ? { raw: sliceOf(text, node as { range?: [number, number, number] | null }) } : {}),
      ...(name ? { isolation: { name, overriddenBy: [...(running[name] ?? [])] } } : {}),
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
 * Applies `values` (key of the section to new value) to the file text and validates the result with the loader's pipeline,
 * applying no isolation override. Returns the edited text and warnings, or the issues that stopped it (the text is never
 * partly edited). The warnings name each edited key a running unit overrides (`running`, as for `readSection`) and, for the
 * `dashboard` section, that it applies at the dashboard's next start and where the page address moves.
 */
// @spec MOD-CFG-009, MOD-CFG-010, MOD-CFG-011, MOD-CFG-012, MOD-CFG-015
export function applySection(text: string, section: string, values: Record<string, unknown>, secretsSet: readonly string[] = [], running: RunningOverrides = {}): ApplyResult {
  const info = readSection(text, section, secretsSet, running).keys;
  const leaves = new Map(leavesOf(section).map((l) => [l.key, l]));
  const issues: ConfigIssue[] = [];
  for (const key of Object.keys(values)) {
    const k = info[key];
    if (!k) issues.push({ path: key, message: `not a key of section ${section}` });
    else if (!k.editable) issues.push({ path: key, message: "a secret; credentials are written through the secret route, not here" });
  }
  if (issues.length) return { ok: false, issues };

  let out = text;
  const edited: { leaf: Leaf; value: unknown }[] = [];
  for (const [key, value] of Object.entries(values)) {
    const leaf = leaves.get(key)!;
    const k = info[key]!;
    try {
      const doc = parseDocument(out);
      if (value === null || value === undefined) { issues.push({ path: key, message: "a value is required" }); continue; }
      if (typeof value === "string" && /\$\{[A-Z0-9_]+(?::-[^}]*)?\}/.test(value)) { issues.push({ path: key, message: "a value cannot contain a ${NAME} placeholder; config.yaml holds literals only" }); continue; }
      out = k.source === "literal" ? replaceNode(out, doc, leaf.path, value) : insertKey(out, doc, leaf.path, value);
      edited.push({ leaf, value });
    } catch (e) {
      issues.push({ path: key, message: (e as Error).message });
    }
  }
  if (issues.length) return { ok: false, issues };

  const valid = parseConfigText(out);
  if (!valid.ok) return { ok: false, issues: valid.issues };

  // The written text must read back as what was asked for (a quote or comment character can change a value).
  const readBack = coerceEmptyNumbers(parseYaml(out));
  for (const e of edited) {
    if (!sameValue(getPath(readBack, e.leaf.path), e.value)) issues.push({ path: e.leaf.key, message: "that value cannot be written to config.yaml as given" });
  }
  if (issues.length) return { ok: false, issues };

  const warnings: string[] = [];
  for (const e of edited) {
    const iso = info[e.leaf.key]!.isolation;
    if (iso && iso.overriddenBy.length) {
      warnings.push(`${e.leaf.path.join(".")}: ${iso.overriddenBy.join(", ")} ${iso.overriddenBy.length === 1 ? "is" : "are"} running isolated with ${iso.name}, so the new value applies only after ${iso.overriddenBy.length === 1 ? "it is" : "they are"} started again without isolation`);
    }
  }
  if (section === "dashboard" && edited.length) {
    warnings.push("dashboard: the dashboard reads these keys when it starts, so the change applies at its next start");
    const ports = edited.filter((e) => e.leaf.key === "port" || e.leaf.key === "lan_port");
    if (ports.length) warnings.push(`dashboard: the dashboard's page address changes to ${ports.map((e) => `${e.leaf.key === "port" ? "port" : "LAN port"} ${String(e.value)}`).join(" and ")} once it is restarted`);
  }
  return { ok: true, text: out, warnings };
}
