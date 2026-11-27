/**
 * The settings editor's engine: reads a section of the stored settings as a list of keys with their source, and applies edited
 * values to the section's stored document. The settings store validates and writes the result (settings-store STORE-SET-002);
 * the dashboard routes (module-contract MOD-CFG-*) are thin wrappers over this module and the store.
 */
import { parse as parseYaml, stringify } from "yaml";
import { z } from "zod";
import { ConfigSchema, SECRET_PATHS, isSecretPrefix, secretPathMatches, secretPathOf } from "./schema.js";
import { PRESENTATION, type KeyPresentation, type SectionPresentation } from "./presentation.js";
import { coerceEmptyNumbers, ISOLATION_OVERRIDES, type ConfigIssue } from "./pipeline.js";

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

/** The names of the entries of the map at `path` in the stored tree; none when it is absent or not a map. */
function mapEntryNames(tree: unknown, path: readonly string[]): string[] {
  const node = getPath(tree, path);
  return isObj(node) ? Object.keys(node) : [];
}

/** `literal` when the stored section holds the key, `default` when it does not. */
export type KeySource = "literal" | "default";

export interface KeyInfo {
  /** Absent for a secret. */
  source?: KeySource;
  /** True for every key except a secret. */
  editable: boolean;
  /** The effective value: the stored value or the schema default. Absent for a secret. */
  value?: unknown;
  /** The stored value of a `literal` key written as YAML. Absent for a secret. */
  raw?: string;
  /** Present (true) only on a secret key, with `set` saying whether the settings store holds a credential for it. */
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

const getPath = (root: unknown, path: readonly string[]): unknown => path.reduce<unknown>((o, k) => (isObj(o) ? o[k] : undefined), root);

/** The override name whose key is `path`, if one selects it. */
const overrideNameOf = (path: string): string | undefined => Object.entries(ISOLATION_OVERRIDES).find(([, key]) => key === path)?.[0];

/** One YAML scalar or collection as text, never folded and never multi-line for a scalar. */
function dump(value: unknown): string {
  if (typeof value === "string" && /[\r\n]/.test(value)) return JSON.stringify(value);
  return stringify(value, { lineWidth: 0 }).replace(/\n+$/, "");
}

/** The effective configuration of a stored tree: `ConfigSchema`'s parse when the tree validates, else the stored tree itself. */
function effectiveOf(tree: Readonly<Json>): unknown {
  const t = coerceEmptyNumbers(structuredClone(tree)) as Json;
  for (const name of Object.keys(ConfigSchema.shape)) t[name] ??= {};
  const r = ConfigSchema.safeParse(t);
  return r.success ? r.data : t;
}

/**
 * Reads one section of the stored settings `tree` (the settings store's sections nested as the schema nests them, sparse): each
 * key's source and effective value, the stored keys the schema does not know, and for each secret only whether `secretsSet`
 * (the secret paths the store holds a credential for) names it. `running` says which units run with each isolation override.
 */
// @spec MOD-CFG-004, MOD-CFG-005, MOD-CFG-006, MOD-CFG-018
export function readSection(tree: Readonly<Json>, section: string, secretsSet: readonly string[] = [], running: RunningOverrides = {}): SectionRead {
  const effective = effectiveOf(tree);
  const keys: Record<string, KeyInfo> = {};
  for (const leaf of leavesOf(section)) {
    const dotted = leaf.path.join(".");
    if (leaf.secret) {
      const star = leaf.path.indexOf("*");
      if (star < 0) {
        keys[leaf.key] = { editable: false, secret: true, set: secretsSet.some((p) => secretPathMatches(p, dotted)) };
        continue;
      }
      // A wildcard credential is one key per entry of the stored map (never an aggregate); only `secret` and `set` are returned.
      const head = leaf.path.slice(0, star);
      const tail = leaf.path.slice(star + 1);
      const rel = leaf.key.slice(0, leaf.key.indexOf("*"));
      for (const name of mapEntryNames(tree, head)) {
        const full = [...head, name, ...tail].join(".");
        keys[`${rel}${[name, ...tail].join(".")}`] = { editable: false, secret: true, set: secretsSet.includes(full) };
      }
      continue;
    }
    const stored = getPath(tree, leaf.path);
    const present = stored !== undefined && stored !== null;
    const value = getPath(effective, leaf.path);
    const name = overrideNameOf(dotted);
    keys[leaf.key] = {
      source: present ? "literal" : "default",
      editable: true,
      ...(value !== undefined ? { value } : {}),
      ...(present ? { raw: dump(stored) } : {}),
      ...(name ? { isolation: { name, overriddenBy: [...(running[name] ?? [])] } } : {}),
    };
  }
  const raw = getPath(tree, section.split("."));
  return { keys, unknown: raw === undefined ? [] : unknownBySchema(raw, schemaAt(section)!, section) };
}

// ---------- writing

/** A section edit: the section's new stored document (`null` when nothing is left in it) and the warnings, or the issues. */
export type ApplyResult = { ok: true; doc: unknown; warnings: string[] } | { ok: false; issues: ConfigIssue[] };

function setAt(root: Json, segs: readonly string[], value: unknown): void {
  let cur = root;
  for (const s of segs.slice(0, -1)) {
    if (!isObj(cur[s])) cur[s] = {};
    cur = cur[s] as Json;
  }
  cur[segs.at(-1)!] = value;
}

/** Removes the key or list entry at `segs`, and every mapping the removal leaves empty. */
function removeAt(node: unknown, segs: readonly (string | number)[]): void {
  const [head, ...rest] = segs;
  if (head === undefined) return;
  if (Array.isArray(node) && typeof head === "number") {
    if (rest.length === 0) node.splice(head, 1);
    else removeAt(node[head], rest);
    return;
  }
  if (!isObj(node) || typeof head !== "string") return;
  if (rest.length === 0) { delete node[head]; return; }
  removeAt(node[head], rest);
  const child = node[head];
  if (isObj(child) && Object.keys(child).length === 0) delete node[head];
}

/**
 * Applies `values` (key of the section, relative as `readSection` names it, to its new value) and `remove` (dotted paths from
 * the config root under the section, a key the schema does not define included) to the section's stored document in `tree`.
 * Returns the section's new stored document and warnings, or the issues that stopped it. The whole configuration is validated
 * by the settings store's write (settings-store STORE-SET-002). The warnings name each edited key a running unit overrides
 * (`running`, as for `readSection`), for the `dashboard` and `logging` sections that the dashboard picks the change up at its
 * next start, and for `dashboard` where the page address moves.
 */
// @spec MOD-CFG-009, MOD-CFG-010, MOD-CFG-011, MOD-CFG-015
export function applySection(
  tree: Readonly<Json>, section: string, values: Record<string, unknown>, remove: readonly string[] = [], secretsSet: readonly string[] = [], running: RunningOverrides = {},
): ApplyResult {
  const info = readSection(tree, section, secretsSet, running).keys;
  const leaves = new Map(leavesOf(section).map((l) => [l.key, l]));
  const issues: ConfigIssue[] = [];
  for (const [key, value] of Object.entries(values)) {
    const k = info[key];
    if (!k) issues.push({ path: key, message: `not a key of section ${section}` });
    else if (!k.editable) issues.push({ path: key, message: "a secret; credentials are written through the secret route, not here" });
    else if (value === null || value === undefined) issues.push({ path: key, message: "a value is required" });
  }
  for (const path of remove) {
    if (path !== section && !path.startsWith(`${section}.`)) issues.push({ path, message: `not a path under section ${section}` });
    else if (secretPathOf(resetPathOf(path)) !== undefined) issues.push({ path, message: "a secret; credentials are cleared through the secret route, not here" });
  }
  if (issues.length) return { ok: false, issues };

  const segs = section.split(".");
  const before = getPath(tree, segs);
  let doc: unknown = before === undefined ? undefined : structuredClone(before);
  for (const path of remove) {
    if (path === section) { doc = undefined; continue; }
    removeAt(doc, pathSegments(path.slice(section.length + 1)));
  }
  const edited: Leaf[] = [];
  for (const [key, value] of Object.entries(values)) {
    const leaf = leaves.get(key)!;
    const rel = leaf.path.slice(segs.length);
    if (rel.length === 0) doc = structuredClone(value);
    else {
      if (!isObj(doc)) doc = {};
      setAt(doc as Json, rel, structuredClone(value));
    }
    edited.push(leaf);
  }

  const warnings: string[] = [];
  for (const leaf of edited) {
    const iso = info[leaf.key]!.isolation;
    if (iso && iso.overriddenBy.length) {
      warnings.push(`${leaf.path.join(".")}: ${iso.overriddenBy.join(", ")} ${iso.overriddenBy.length === 1 ? "is" : "are"} running isolated with ${iso.name}, so the new value applies only after ${iso.overriddenBy.length === 1 ? "it is" : "they are"} started again without isolation`);
    }
  }
  if (section === "logging" && edited.length) {
    warnings.push("logging: the dashboard reads these keys when it starts, so it picks the change up at its next start");
  }
  if (section === "dashboard" && edited.length) {
    warnings.push("dashboard: the dashboard reads these keys when it starts, so the change applies at its next start");
    const ports = edited.filter((l) => l.key === "port" || l.key === "lan_port");
    if (ports.length) warnings.push(`dashboard: the dashboard's page address changes to ${ports.map((l) => `${l.key === "port" ? "port" : "LAN port"} ${String(values[l.key])}`).join(" and ")} once it is restarted`);
  }
  return { ok: true, doc: doc === undefined || (isObj(doc) && Object.keys(doc).length === 0) ? null : doc, warnings };
}

// ---------- recovery: one key at a time in stored settings that fail the schema (the dashboard's config recovery mode)

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

/**
 * The schema a value set at `path` must satisfy (a key's own, or a list's element for `key[i]`), or why nothing can be set
 * there on its own (an entry inside a list entry, a list entry that is not a single value, a credential, no such key, a whole
 * section).
 */
export function settableSchema(path: string): z.ZodType | string {
  const entry = /^(.+)\[(\d+)\]$/.exec(path);
  const key = entry ? entry[1]! : path;
  if (key.includes("[")) return "an entry inside a list entry cannot be set on its own: reset the list, or edit it on the Settings screen";
  if (secretPathOf(key) !== undefined || isSecretPrefix(key)) return "a credential: set it through its masked field on the Settings screen";
  const schema = key === "" ? undefined : schemaAt(key);
  if (!schema) return "not a setting of this build";
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

/** True when a value its schema accepts can be set at `path` on its own: a key `ConfigSchema` defines, or a single-value list entry. */
export const canSetKey = (path: string): boolean => typeof settableSchema(path) !== "string";

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
