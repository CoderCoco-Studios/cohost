/**
 * The settings editor's engine: reads a section of `config.yaml` as a list of keys with their source, and writes edited
 * values back into the file text in place (every byte outside the edited values is left as the owner wrote it). The
 * dashboard routes (module-contract MOD-CFG-*) are thin wrappers over this module.
 */
import { createHash } from "node:crypto";
import { parse as parseYaml, parseDocument, isMap, isScalar, stringify, type Document, type YAMLMap } from "yaml";
import { z } from "zod";
import { ConfigSchema, SECRET_PATHS, isSecretPrefix, secretPathMatches, secretPathOf } from "./schema.js";
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
    const shape = shapeOf(u);
    if (!Object.hasOwn(shape, seg)) return undefined;
    const next = shape[seg];
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
    const shape = shapeOf(obj);
    cur = Object.hasOwn(shape, key) ? shape[key] : undefined;
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
// @spec MOD-CFG-019, MOD-CFG-020, MOD-CFG-021, MOD-CFG-022, CFG-PRES-010
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

/** The keys of the map at `path` in a parsed document: own keys only, none when the section is missing or not a map. */
function mapEntryNames(doc: Document, path: readonly string[]): string[] {
  const node = doc.getIn(path, true);
  if (!isMap(node)) return [];
  return node.items.map((i) => (isScalar(i.key) ? String(i.key.value) : String(i.key)));
}

/** The server names under `tools.servers` in the saved `config.yaml` text; none for a missing section or unparseable text. */
// @spec DASH-SECRET-013
export function toolServerNames(text: string): string[] {
  const doc = parseDocument(text);
  if (doc.errors.length) return [];
  return mapEntryNames(doc, ["tools", "servers"]);
}

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
      const star = leaf.path.indexOf("*");
      if (star < 0) {
        keys[leaf.key] = { editable: false, secret: true, set: secretsSet.some((p) => secretPathMatches(p, dotted)) };
        continue;
      }
      // A wildcard credential is one key per entry of the map the file holds (never an aggregate); only `secret` and `set` are returned.
      const head = leaf.path.slice(0, star);
      const tail = leaf.path.slice(star + 1);
      const rel = leaf.key.slice(0, leaf.key.indexOf("*"));
      for (const name of mapEntryNames(doc, head)) {
        const full = [...head, name, ...tail].join(".");
        keys[`${rel}${[name, ...tail].join(".")}`] = { editable: false, secret: true, set: secretsSet.includes(full) };
      }
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
      // A map that holds a credential (a secret prefix, `tools.servers`) never returns its text: a token pasted into the file is in it.
      ...(present && !isSecretPrefix(dotted) ? { raw: sliceOf(text, node as { range?: [number, number, number] | null }) } : {}),
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
function replaceNode(text: string, doc: Document, path: (string | number)[], value: unknown): string {
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

/** A YAML scalar: what a value that is not an object can be. */
type Scalar = string | number | boolean | null | undefined;
const sameValue = (a: unknown, b: unknown): boolean =>
  typeof a === "object" || typeof b === "object" ? JSON.stringify(a) === JSON.stringify(b) : String(a as Scalar) === String(b as Scalar);

/**
 * Applies `values` (key of the section to new value) to the file text and validates the result with the loader's pipeline,
 * applying no isolation override. Returns the edited text and warnings, or the issues that stopped it (the text is never
 * partly edited). The warnings name each edited key a running unit overrides (`running`, as for `readSection`), for the
 * `dashboard` and `logging` sections that the dashboard picks the change up at its next start, and for `dashboard` where the
 * page address moves.
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
  if (section === "logging" && edited.length) {
    warnings.push("logging: the dashboard reads these keys when it starts, so it picks the change up at its next start");
  }
  if (section === "dashboard" && edited.length) {
    warnings.push("dashboard: the dashboard reads these keys when it starts, so the change applies at its next start");
    const ports = edited.filter((e) => e.leaf.key === "port" || e.leaf.key === "lan_port");
    if (ports.length) warnings.push(`dashboard: the dashboard's page address changes to ${ports.map((e) => `${e.leaf.key === "port" ? "port" : "LAN port"} ${String(e.value)}`).join(" and ")} once it is restarted`);
  }
  return { ok: true, text: out, warnings };
}

// ---------- recovery editing: one key at a time in a file that does not validate (the dashboard's config recovery mode)

/** The result of a recovery edit: the new text, or the issues that refused it (nothing is edited then). */
export type RecoveryEdit = { ok: true; text: string } | { ok: false; issues: ConfigIssue[] };

const PLACEHOLDER_IN = /\$\{[A-Z0-9_]+(?::-[^}]*)?\}/;
const PLACEHOLDERS = /\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g;

/** A dotted path with `[i]` list indexes as segments of their own: `a.b[0].c` is `["a", "b", 0, "c"]`. */
export function pathSegments(path: string): (string | number)[] {
  const out: (string | number)[] = [];
  for (const part of path.split(".")) {
    const m = /^([^[]*)((?:\[\d+\])*)$/.exec(part);
    if (!m) { out.push(part); continue; }
    if (m[1]) out.push(m[1]);
    for (const idx of m[2]!.matchAll(/\[(\d+)\]/g)) out.push(Number(idx[1]));
  }
  return out;
}

/** The key a problem at `path` is reset through: the path before its first list index (a list is reset whole). */
export const resetPathOf = (path: string): string => path.split("[")[0]!;

/** Why the key at `path` cannot be set on its own (a list entry, a credential, no such key, a whole section), or undefined. */
function settableRefusal(path: string): string | undefined {
  const target = settableSchema(path);
  return typeof target === "string" ? target : undefined;
}

/** The schema a value set at `path` must satisfy (a key's own, or a list's element for `key[i]`), or why nothing can be set there. */
function settableSchema(path: string): z.ZodType | string {
  const entry = /^(.+)\[(\d+)\]$/.exec(path);
  const key = entry ? entry[1]! : path;
  if (key.includes("[")) return "an entry inside a list entry cannot be set on its own: reset the list, or edit it on the Settings screen";
  if (secretPathOf(key) !== undefined || isSecretPrefix(key)) return "a credential: it belongs in secrets.yaml, set through its masked field on the Settings screen";
  const schema = key === "" ? undefined : schemaAt(key);
  if (!schema) return "not a key config.yaml defines";
  const inner = unwrap(schema).schema;
  if (entry) {
    if (!(inner instanceof z.ZodArray)) return "not a list";
    const element = inner.element as z.ZodType;
    const u = unwrap(element).schema;
    if (u instanceof z.ZodObject || u instanceof z.ZodArray || u instanceof z.ZodRecord) return "a list entry that is not a single value cannot be set on its own: reset the list, or edit it on the Settings screen";
    return element;
  }
  if (inner instanceof z.ZodObject) return "a section, not a key: set its keys one at a time";
  return schema;
}

/** True when `setConfigKey` can set the key at `path` given a value its schema accepts. */
export const canSetKey = (path: string): boolean => settableRefusal(path) === undefined;

/**
 * What an operator typed for the key at `path`, as the value to set: the text read as YAML when that satisfies the key's schema
 * (`3000` a number, `[a, b]` a list), else the text itself (`qwen2.5:7b`, `null` for a string key).
 */
export function inputValue(path: string, input: string): unknown {
  const target = settableSchema(path);
  const schema = typeof target === "string" ? undefined : target;
  let parsed: unknown;
  try { parsed = parseYaml(input); } catch { return input; }
  if (schema && schema.safeParse(parsed).success) return parsed;
  return schema && schema.safeParse(input).success ? input : parsed ?? input;
}

/**
 * The tree of one section of the file text on its own, nulls dropped as the loader drops them, or undefined when the text does
 * not parse, the section is absent or not a mapping, or a `${NAME}` placeholder appears in it: the dashboard's recovery mode
 * reads its address from it while the rest of the file fails.
 */
export function rawSection(text: string, section: string): Record<string, unknown> | undefined {
  let tree: unknown;
  try { tree = parseYaml(text); } catch { return undefined; }
  const node = getPath(coerceEmptyNumbers(tree), section.split("."));
  if (!isObj(node) || PLACEHOLDER_IN.test(JSON.stringify(node))) return undefined;
  return node;
}

/**
 * Sets one key of `config.yaml` by its dotted path from the root, with the settings editor's splicing (every other byte kept),
 * checking the key alone: the rest of the file may fail, which is why this exists beside `applySection`.
 */
// @spec CFG-RCV-003
export function setConfigKey(text: string, path: string, value: unknown): RecoveryEdit {
  const fail = (message: string): RecoveryEdit => ({ ok: false, issues: [{ path, message }] });
  const schema = settableSchema(path);
  if (typeof schema === "string") return fail(schema);
  const entry = path.includes("[");
  if (value === null || value === undefined) return fail("a value is required");
  if (PLACEHOLDER_IN.test(JSON.stringify(value))) return fail("a value cannot contain a ${NAME} placeholder; config.yaml holds literals only");
  const check = schema.safeParse(value);
  if (!check.success) return fail(check.error.issues.map((i) => i.message).join("; "));
  const doc = parseDocument(text);
  if (doc.errors.length) return fail("config.yaml is not valid YAML: fix the syntax error by hand first");
  const segs = pathSegments(path);
  let out: string;
  try {
    const node = doc.getIn(segs, true);
    const present = node !== undefined && node !== null && !(isScalar(node) && node.value === null);
    if (entry && !isScalar(node)) return fail("the list does not hold a single value at this entry");
    out = present ? replaceNode(text, doc, segs, value) : insertKey(text, doc, segs as string[], value);
  } catch (e) {
    return fail((e as Error).message);
  }
  let readBack: unknown;
  try { readBack = segs.reduce<unknown>((o, k) => (o !== null && typeof o === "object" ? (o as Record<string | number, unknown>)[k] : undefined), coerceEmptyNumbers(parseYaml(out))); } catch { return fail("that value cannot be written to config.yaml as given"); }
  if (!sameValue(readBack, value)) return fail("that value cannot be written to config.yaml as given");
  return { ok: true, text: out };
}

type Ranged = { range?: [number, number, number] | null };

/** The position just after the `:` that follows a mapping key ending at `keyEnd`. */
const colonAfter = (text: string, keyEnd: number): number => text.indexOf(":", keyEnd) + 1;

/**
 * Removes the key at `path` (cut before its first `[`, so a list is reset whole) from the text, so its schema default applies:
 * the key's lines with their comments, every other byte kept; a block mapping it leaves empty is written `{}` and a key of a flow
 * mapping is cut out with its separator. Refused when the text does not hold the key or does not parse.
 */
// @spec CFG-RCV-004
export function resetConfigKey(text: string, path: string): { ok: true; text: string; path: string } | { ok: false; issues: ConfigIssue[] } {
  const keyPath = resetPathOf(path);
  const fail = (message: string) => ({ ok: false as const, issues: [{ path: keyPath, message }] });
  const doc = parseDocument(text);
  if (doc.errors.length) return fail("config.yaml is not valid YAML: fix the syntax error by hand first");
  const segs = keyPath.split(".");
  const parentPath = segs.slice(0, -1);
  const parent = parentPath.length ? doc.getIn(parentPath, true) : doc.contents;
  const last = segs[segs.length - 1]!;
  const idx = isMap(parent) ? parent.items.findIndex((p) => isScalar(p.key) && String(p.key.value) === last) : -1;
  if (!isMap(parent) || idx < 0) return fail("config.yaml does not hold this key: it already has its default");
  const pair = parent.items[idx]!;
  const key = pair.key as Ranged;
  const valueEnd = ((pair.value as Ranged | null)?.range ?? key.range!)[1];

  if (parent.flow) {
    if (parent.items.length === 1) { const r = parent.range!; return { ok: true, text: `${text.slice(0, r[0])}{}${text.slice(r[1])}`, path: keyPath }; }
    const next = parent.items[idx + 1];
    if (next) return { ok: true, text: text.slice(0, key.range![0]) + text.slice((next.key as Ranged).range![0]), path: keyPath };
    const prev = parent.items[idx - 1]!;
    const prevEnd = ((prev.value as Ranged | null)?.range ?? (prev.key as Ranged).range!)[1];
    return { ok: true, text: text.slice(0, prevEnd) + text.slice(valueEnd), path: keyPath };
  }

  const start = lineStart(text, key.range![0]);
  let end = endOfContentLine(text, valueEnd);
  if (text[end] === "\n") end++;
  let out = text.slice(0, start) + text.slice(end);
  // The last key of a block mapping: the mapping stays, written `{}`, so its own defaults apply instead of the section going missing.
  if (parent.items.length === 1 && parentPath.length) {
    const grand = parentPath.length > 1 ? doc.getIn(parentPath.slice(0, -1), true) : doc.contents;
    const owner = isMap(grand) ? grand.items.find((p) => isScalar(p.key) && String(p.key.value) === parentPath[parentPath.length - 1]) : undefined;
    const ownerKey = owner?.key as Ranged | undefined;
    if (ownerKey?.range && ownerKey.range[1] <= start) {
      const at = colonAfter(out, ownerKey.range[1]);
      if (at > 0) out = `${out.slice(0, at)} {}${out.slice(at)}`;
    }
  }
  return { ok: true, text: out, path: keyPath };
}

/**
 * The value a `${NAME:-fallback}` placeholder at `path` declares: an unquoted value that is exactly the placeholder gives the
 * fallback read as YAML, any other gives the string with each placeholder replaced by its fallback. Undefined when a placeholder
 * there has no fallback, the key holds none, or the text does not parse.
 */
// @spec CFG-RCV-005
export function placeholderFallback(text: string, path: string): { value: unknown } | undefined {
  const doc = parseDocument(text);
  if (doc.errors.length) return undefined;
  const node = doc.getIn(pathSegments(path), true);
  if (!isScalar(node) || typeof node.value !== "string") return undefined;
  const str = node.value;
  const found = [...str.matchAll(PLACEHOLDERS)];
  if (found.length === 0 || found.some((m) => m[2] === undefined)) return undefined;
  if (node.type === "PLAIN" && found.length === 1 && found[0]![0] === str) {
    try { return { value: parseYaml(found[0]![2]!) as unknown }; } catch { return { value: found[0]![2]! }; }
  }
  return { value: str.replace(PLACEHOLDERS, (_m, _name: string, fb: string) => fb) };
}
