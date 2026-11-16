// The Settings screen's view of `GET /config/schema`: one module reads the wire shape (MOD-CFG-019 to MOD-CFG-021), so a
// change of encoding touches only this file. Everything the screen shows about a section or key comes from here; the
// screen itself names no section, title, group or help text (design: Settings screen).

export interface JsonSchema {
  type?: string;
  enum?: unknown[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: unknown;
  items?: JsonSchema;
  required?: string[];
  minimum?: number; maximum?: number; exclusiveMinimum?: number; exclusiveMaximum?: number;
  minLength?: number; maxLength?: number; minItems?: number; pattern?: string;
  default?: unknown;
  description?: string;
  "x-secret"?: boolean;
  "x-sensitive"?: boolean;
}

export interface Option { value: string; label: string }
export type ModelKind = "chat" | "small" | "vision" | "embed" | "stt";
const MODEL_KINDS: readonly string[] = ["chat", "small", "vision", "embed", "stt"];

/** The control a key gets (design: Widgets). `props` of `objects` is the card's properties, each with its own control. */
export type Control =
  | { kind: "switch" }
  | { kind: "segmented"; options: Option[] }
  | { kind: "select"; options: Option[] }
  | { kind: "slider"; min: number; max: number; step: number }
  | { kind: "number" }
  | { kind: "text" }
  | { kind: "textarea" }
  | { kind: "lines" }
  | { kind: "chips"; options: Option[] }
  | { kind: "sources" }
  | { kind: "timezone" }
  | { kind: "model"; modelKind: ModelKind }
  | { kind: "voice" }
  | { kind: "secret" }
  | { kind: "objects"; props: ItemProp[] }
  | { kind: "json" };

export interface ItemProp { name: string; label: string; help?: string; unit?: string; schema: JsonSchema; control: Control; required: boolean }

export interface KeyModel {
  /** The key's name relative to its section (`notes.capture.enabled`; a leaf section's key is its own last segment). */
  key: string;
  label: string;
  help?: string;
  unit?: string;
  schema: JsonSchema;
  control: Control;
  sensitive: boolean;
  secret: boolean;
}

export interface SectionModel {
  path: string;
  title: string;
  group: string;
  about: string;
  page?: string;
  services: string[];
  keys: KeyModel[];
}

export interface SchemaModel { groups: string[]; sections: SectionModel[] }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** `speak_rate_ms` as `Speak rate ms`; with `unit` `ms` the suffix is dropped: `Speak rate` (DASH-SET-003). */
export function deriveLabel(name: string, unit?: string): string {
  const last = name.split(".").pop() ?? name;
  let words = last.replace(/_/g, " ").trim();
  if (unit) {
    const suffix = ` ${unit.toLowerCase()}`;
    if (words.toLowerCase().endsWith(suffix) && words.length > suffix.length) words = words.slice(0, -suffix.length);
  }
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const titleOf = (path: string): string => deriveLabel(path.split(".").pop() ?? path);

function parseOptions(raw: unknown): Option[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: Option[] = [];
  for (const o of raw) {
    if (!isObj(o) || typeof o.value !== "string" || typeof o.label !== "string") return undefined;
    out.push({ value: o.value, label: o.label });
  }
  return out;
}

/** Labels for an enum's values: the `options` widget's label where it names the value, the value itself otherwise. */
function labelled(values: unknown[], widget: unknown): Option[] {
  const given = isObj(widget) && widget.type === "options" ? parseOptions(widget.options) : undefined;
  return values.map((v) => { const value = String(v); return { value, label: given?.find((o) => o.value === value)?.label ?? value }; });
}

/**
 * The control for one schema and its presentation. A widget hint only refines the generic control of the schema's type;
 * an unknown hint, an unknown model kind or a hint on a type it does not fit is treated as absent (DASH-SET-013).
 * Inside a card (`inItem`) an enum is always a select (design: the array-of-objects row).
 */
export function controlFor(schema: JsonSchema, pres: { widget?: unknown; items?: unknown } | undefined, opts: { secret?: boolean; inItem?: boolean } = {}): Control {
  if (opts.secret) return { kind: "secret" };
  const widget = isObj(pres?.widget) ? pres!.widget : undefined;
  const wtype = widget && typeof widget.type === "string" ? widget.type : undefined;
  const t = schema.type;
  if (t === "string" && !schema.enum) {
    if (wtype === "timezone") return { kind: "timezone" };
    if (wtype === "voice") return { kind: "voice" };
    if (wtype === "model" && typeof widget!.kind === "string" && MODEL_KINDS.includes(widget!.kind)) return { kind: "model", modelKind: widget!.kind as ModelKind };
    if (wtype === "textarea") return { kind: "textarea" };
  }
  if (t === "boolean") return { kind: "switch" };
  if (t === "string" && Array.isArray(schema.enum) && schema.enum.length > 0) {
    const options = labelled(schema.enum, widget);
    const segmented = !opts.inItem && options.length <= 4;
    // An enum with no default is an optional setting (a module's provider override): it needs a choice that clears it.
    if (segmented && schema.default === undefined) options.unshift({ value: "", label: "Not set" });
    return { kind: segmented ? "segmented" : "select", options };
  }
  if (t === "integer" || t === "number") {
    const min = num(schema.minimum), max = num(schema.maximum);
    if (min !== undefined && max !== undefined && max - min <= 100 && max > min) {
      return { kind: "slider", min, max, step: t === "integer" ? 1 : max - min <= 2 ? 0.01 : 0.05 };
    }
    return { kind: "number" };
  }
  if (t === "string") return { kind: "text" };
  if (t === "array" && schema.items) {
    const it = schema.items;
    if (it.type === "string" && Array.isArray(it.enum) && it.enum.length > 0) return { kind: "chips", options: labelled(it.enum, widget) };
    if (it.type === "string" && wtype === "sources") return { kind: "sources" };
    if (it.type === "string") return { kind: "lines" };
    if (it.type === "object" && isObj(it.properties)) {
      const itemPres = isObj(pres?.items) ? pres!.items as Record<string, unknown> : {};
      const required = new Set(it.required ?? []);
      const props: ItemProp[] = Object.entries(it.properties).map(([name, s]) => {
        const p = isObj(itemPres[name]) ? itemPres[name] as Record<string, unknown> : {};
        const unit = str(p.unit);
        return { name, label: str(p.label) ?? deriveLabel(name, unit), help: str(p.help) ?? s.description, unit, schema: s, control: controlFor(s, p, { inItem: true }), required: required.has(name) };
      });
      return { kind: "objects", props };
    }
  }
  return { kind: "json" };
}

function keyModel(key: string, schema: JsonSchema, pres: Record<string, unknown> | undefined, secrets: Set<string>): KeyModel {
  const secret = !!schema["x-secret"] || secrets.has(key);
  const unit = str(pres?.unit);
  return {
    key, schema, secret, unit,
    label: str(pres?.label) ?? deriveLabel(key, unit),
    help: str(pres?.help) ?? schema.description,
    sensitive: pres?.sensitive === true || !!schema["x-sensitive"],
    control: controlFor(schema, pres, { secret }),
  };
}

/** The keys of a section's JSON Schema, named relative to the section like `GET /config/:section`; an object with no listed properties is one key. */
function leaves(path: string, schema: JsonSchema, rel: string[], out: { key: string; schema: JsonSchema }[]): void {
  if (schema.type === "object" && isObj(schema.properties) && Object.keys(schema.properties).length > 0) {
    for (const [k, v] of Object.entries(schema.properties)) leaves(path, v, [...rel, k], out);
    return;
  }
  out.push({ key: rel.length ? rel.join(".") : path.split(".").pop()!, schema });
}

/** Reads a `GET /config/schema` answer. Throws when it is not the expected shape. */
export function parseSchema(payload: unknown): SchemaModel {
  if (!isObj(payload) || !Array.isArray(payload.sections)) throw new Error("the schema answer has an unexpected shape");
  const groups = Array.isArray(payload.groups) ? payload.groups.filter((g): g is string => typeof g === "string") : [];
  const sections: SectionModel[] = [];
  for (const raw of payload.sections) {
    if (!isObj(raw) || typeof raw.path !== "string" || !isObj(raw.schema)) continue;
    const path = raw.path;
    const pres = isObj(raw.keys) ? raw.keys : {};
    const secrets = new Set(Array.isArray(raw.secrets) ? raw.secrets.filter((s): s is string => typeof s === "string") : []);
    const found: { key: string; schema: JsonSchema }[] = [];
    leaves(path, raw.schema as JsonSchema, [], found);
    sections.push({
      path,
      title: str(raw.title) ?? titleOf(path),
      group: str(raw.group) ?? titleOf(path.split(".")[0]!),
      about: str(raw.about) ?? "",
      page: str(raw.page),
      services: Array.isArray(raw.services) ? raw.services.filter((s): s is string => typeof s === "string") : [],
      keys: found.map((f) => keyModel(f.key, f.schema, isObj(pres[f.key]) ? pres[f.key] as Record<string, unknown> : undefined, secrets)),
    });
  }
  return { groups, sections };
}

/** The navigation: the groups in the answer's order (then any group a section names that the answer's list lacks), each with its listed sections; a section with `page` is not listed (DASH-SET-001). Empty groups are left out. */
export function navGroups(model: SchemaModel): { group: string; sections: SectionModel[] }[] {
  const names = [...model.groups];
  for (const s of model.sections) if (!names.includes(s.group)) names.push(s.group);
  return names
    .map((group) => ({ group, sections: model.sections.filter((s) => s.group === group && !s.page) }))
    .filter((g) => g.sections.length > 0);
}

/** The page a section path opens: its listed section and the sections shown on it (DASH-SET-002). A section with `page` resolves to that page; an unknown path is undefined. */
export function pageOf(model: SchemaModel, path: string): { primary: SectionModel; members: SectionModel[] } | undefined {
  let primary = model.sections.find((s) => s.path === path);
  if (primary?.page) primary = model.sections.find((s) => s.path === primary!.page) ?? primary;
  if (!primary) return undefined;
  return { primary, members: [primary, ...model.sections.filter((s) => s.page === primary!.path && s !== primary)] };
}

/** A section's keys grouped by path prefix in first-seen order; keys with no prefix are under General (DASH-SET-025). */
export function keyGroups(section: SectionModel): { id: string; title: string; keys: KeyModel[] }[] {
  const out: { id: string; title: string; keys: KeyModel[] }[] = [];
  for (const k of section.keys) {
    const parts = k.key.split(".");
    const id = parts.slice(0, -1).join(".");
    let g = out.find((x) => x.id === id);
    if (!g) { g = { id, title: id === "" ? "General" : deriveLabel(id.replace(/\./g, " ")), keys: [] }; out.push(g); }
    g.keys.push(k);
  }
  return out;
}

/** What `GET /config/:section` says about one key. */
export interface KeyRead { source?: string; editable?: boolean; value?: unknown; secret?: boolean; set?: boolean; isolation?: { name: string; overriddenBy: string[] } }

const fmtDefault = (v: unknown): string | undefined => {
  if (typeof v === "boolean") return v ? "On" : "Off";
  if (typeof v === "string") return v === "" ? "empty" : JSON.stringify(v);
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return v.length === 0 ? "none" : v.every((x) => typeof x !== "object") ? v.join(", ") : `${v.length} ${v.length === 1 ? "item" : "items"}`;
  return undefined;
};

/** The note under a key: its range, its default, and (for a key absent from the file) that saving adds it (DASH-SET-004). */
export function noteFor(key: KeyModel, info: KeyRead | undefined): string {
  const s = key.schema;
  const parts: string[] = [];
  if (s.type === "integer" || s.type === "number") {
    const min = num(s.minimum), max = num(s.maximum);
    if (min !== undefined && max !== undefined) parts.push(`Range ${min} to ${max}.`);
    else if (min !== undefined) parts.push(`At least ${min}.`);
    else if (max !== undefined) parts.push(`At most ${max}.`);
    else if (num(s.exclusiveMinimum) !== undefined) parts.push(`Above ${s.exclusiveMinimum}.`);
  }
  const d = fmtDefault(s.default);
  if (d !== undefined) parts.push(`Default ${d}.`);
  if (info && !key.secret && info.source === "default") parts.push("Not in config.yaml yet. Saving a change adds it.");
  return parts.join(" ");
}

/** The source column: `secret`, `default` for a key absent from the file, `config.yaml` for every other key (DASH-SET-004). */
export function sourceLabel(info: KeyRead | undefined): string {
  if (info?.secret) return "secret";
  return info?.source === "default" ? "default" : "config.yaml";
}

/**
 * Which key of a section a server issue path belongs to, and the rest of the path inside it (`0.match` inside a reflexes
 * list). The path may carry the section path or not, and an array index as `[0]` or `.0` (DASH-SET-005).
 */
export function matchIssue(section: string, keys: readonly string[], issuePath: string): { key: string; rest: string } | undefined {
  let p = issuePath.replace(/\[(\d+)\]/g, ".$1").replace(/^\./, "");
  if (p === "") return undefined;
  const bare = section.split(".").pop()!;
  const candidates = [p];
  if (p === section || p.startsWith(`${section}.`)) candidates.push(p.slice(section.length + 1));
  if (keys.includes(bare) && keys.length === 1) candidates.push(bare);
  let best: { key: string; rest: string } | undefined;
  for (const c of candidates) {
    for (const k of keys) {
      if (c === k || c.startsWith(`${k}.`)) {
        const rest = c === k ? "" : c.slice(k.length + 1);
        if (!best || k.length > best.key.length) best = { key: k, rest };
      }
    }
  }
  return best;
}
