import { parse as parseYaml } from "yaml";
import { ConfigSchema, SECRET_PATHS, secretPathOf, type Config } from "./schema.js";

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

// ---------- isolation overrides

/** The one environment variable that can change a setting: set by the control plane for an isolated start of one unit. */
export const ISOLATION_ENV = "COHOST_ISOLATION";

/**
 * The fourteen override names `COHOST_ISOLATION` may carry, each mapped to the key path it overrides. They are labels in
 * that JSON object, not environment variables: a variable named `AVATAR_DRIVER` is read by nothing.
 */
// @spec CFG-ISO-006
export const ISOLATION_OVERRIDES = {
  LLM_PROVIDER: "llm.provider",
  MEMORY_STORE: "brain.memory.store",
  MEMORY_EMBEDDER: "brain.memory.embedder",
  VOICE_ENGINE: "voice.engine",
  CHAT_SOURCES: "chat.sources",
  VISION_ENABLED: "vision.enabled",
  VISION_PROVIDER: "vision.provider",
  EARS_SOURCES: "ears.sources",
  EARS_STT_ENGINE: "ears.stt_engine",
  CONNECTIONS_DISCORD_ENABLED: "connections.discord.enabled",
  MOUTH_DISCORD_ENABLED: "mouth.outputs.discord.enabled",
  MOUTH_DRYRUN_ENABLED: "mouth.outputs.dryrun.enabled",
  AVATAR_DRIVER: "avatar.driver",
  TOOLS_MODE: "tools.mode",
} as const;
export type IsolationName = keyof typeof ISOLATION_OVERRIDES;

/** Override values parsed as a YAML flow value (the boolean keys and the list); every other value stays a string. */
// @spec CFG-ISO-007
const YAML_VALUED: ReadonlySet<string> = new Set(["VISION_ENABLED", "CONNECTIONS_DISCORD_ENABLED", "MOUTH_DISCORD_ENABLED", "MOUTH_DRYRUN_ENABLED", "CHAT_SOURCES", "EARS_SOURCES"]);

/** A set of overrides: override name to the string value to apply. */
export type IsolationOverrides = Readonly<Record<string, string>>;

/**
 * Parses a `COHOST_ISOLATION` value: nothing for an unset or empty one, else a JSON object from override name to string.
 * Anything else, or a name `ISOLATION_OVERRIDES` does not hold, throws an error naming `COHOST_ISOLATION`.
 */
// @spec CFG-ISO-007, CFG-ISO-010
export function decodeIsolation(value: string | undefined): IsolationOverrides {
  if (value === undefined || value.trim() === "") return {};
  let obj: unknown;
  try { obj = JSON.parse(value); } catch { throw new Error(`${ISOLATION_ENV} is not valid JSON: it must be a JSON object from override name to string`); }
  if (!isObj(obj)) throw new Error(`${ISOLATION_ENV} must be a JSON object from override name to string`);
  const unknown = Object.keys(obj).filter((k) => !Object.hasOwn(ISOLATION_OVERRIDES, k));
  if (unknown.length) throw new Error(`${ISOLATION_ENV} names unknown override${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")} (the names are ${Object.keys(ISOLATION_OVERRIDES).join(", ")})`);
  const notString = Object.entries(obj).filter(([, v]) => typeof v !== "string").map(([k]) => k);
  if (notString.length) throw new Error(`${ISOLATION_ENV}: the value of ${notString.join(", ")} must be a string`);
  return obj as IsolationOverrides;
}

/** The value for `COHOST_ISOLATION` that carries `overrides`: a JSON object, and the empty string for none. Throws for an unknown name. */
// @spec CFG-ISO-007
export function encodeIsolation(overrides: IsolationOverrides): string {
  const names = Object.keys(overrides);
  const unknown = names.filter((k) => !Object.hasOwn(ISOLATION_OVERRIDES, k));
  if (unknown.length) throw new Error(`not an isolation override: ${unknown.join(", ")}`);
  return names.length === 0 ? "" : JSON.stringify(overrides);
}

/**
 * The overrides a `COHOST_ISOLATION` value carries, as override name and the key it overrides, in the order written (the value
 * is the process's own by default). An empty, absent or malformed value reports none: the caller is a status probe reading a
 * container's environment, which must not fail on it.
 */
// @spec CFG-ISO-007
export function isolationOverriddenKeys(value: string | undefined = process.env[ISOLATION_ENV]): { name: IsolationName; key: string }[] {
  try {
    return Object.keys(decodeIsolation(value)).map((name) => ({ name: name as IsolationName, key: ISOLATION_OVERRIDES[name as IsolationName] }));
  } catch {
    return [];
  }
}

function setPath(root: Record<string, unknown>, path: string, value: unknown): void {
  const segs = path.split(".");
  let cur = root;
  for (const seg of segs.slice(0, -1)) {
    if (!isObj(cur[seg])) cur[seg] = {};
    cur = cur[seg] as Record<string, unknown>;
  }
  if (value === null || value === undefined) delete cur[segs[segs.length - 1]!];
  else cur[segs[segs.length - 1]!] = value;
}

const getPath = (root: unknown, path: string): unknown => path.split(".").reduce<unknown>((o, k) => (isObj(o) ? o[k] : undefined), root);

/**
 * The key lists of the places a secret pattern names in `root`: a `*` segment expands to each key the map holds there, and a
 * wildcard-free segment names one key only when the map holds it (CFG-SEC-016).
 */
function concreteKeys(node: unknown, segs: string[], prefix: string[] = []): string[][] {
  if (segs.length === 0) return [prefix];
  if (!isObj(node)) return [];
  const [head, ...rest] = segs as [string, ...string[]];
  const keys = head === "*" ? Object.keys(node) : Object.hasOwn(node, head) ? [head] : [];
  return keys.flatMap((k) => concreteKeys(node[k], rest, [...prefix, k]));
}

/** Sets each override at its key path; a value that parses to nothing removes the key so the schema default applies. */
export function applyIsolation(tree: Record<string, unknown>, overrides: IsolationOverrides): void {
  for (const [name, text] of Object.entries(overrides)) {
    let value: unknown = text;
    if (YAML_VALUED.has(name)) {
      try { value = parseYaml(text); } catch { value = text; }
    }
    setPath(tree, ISOLATION_OVERRIDES[name as IsolationName], value);
  }
}

// ---------- placeholders and null dropping

const PLACEHOLDER = /\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g;

/**
 * One issue per `${NAME}` or `${NAME:-default}` placeholder in a string value, at the key's dotted path (an array entry as
 * `path[index]`): no placeholder is ever substituted, so every settings write refuses one (CFG-ENV-011).
 */
// @spec CFG-ENV-011
export function placeholderIssues(raw: unknown, path = ""): ConfigIssue[] {
  if (typeof raw === "string") {
    return [...raw.matchAll(PLACEHOLDER)].map((m) => ({
      path,
      message: `uses the placeholder \${${m[1]}}; ${SECRET_PATHS.includes(path) ? "set the credential through its masked field on the Settings screen or with mise run config:secret" : "write the value as a literal"} (\${...} is not supported in the settings and no environment variable is substituted; there is no escape, so to keep this text literal write the name in lower-case or reword it)`,
    }));
  }
  if (Array.isArray(raw)) return raw.flatMap((v, i) => placeholderIssues(v, `${path}[${i}]`));
  if (isObj(raw)) return Object.entries(raw).flatMap(([k, v]) => placeholderIssues(v, path ? `${path}.${k}` : k));
  return [];
}

// @spec CFG-LOAD-002
export function coerceEmptyNumbers(raw: unknown): unknown {
  // A key written with no value (`port:`) is null. Leave it to defaults.
  if (Array.isArray(raw)) return raw.map(coerceEmptyNumbers);
  if (raw && typeof raw === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (v === null) continue;
      out[k] = coerceEmptyNumbers(v);
    }
    return out;
  }
  return raw;
}

/** Keys present in the yaml that the schema doesn't know (typos, retired settings), including inside array entries as `path[index].key`. */
export function unknownKeys(raw: unknown, parsed: unknown, path = ""): string[] {
  if (Array.isArray(raw) && Array.isArray(parsed)) return raw.flatMap((v, i) => unknownKeys(v, parsed[i], `${path}[${i}]`));
  if (!isObj(raw) || !isObj(parsed)) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(raw)) {
    const here = path ? `${path}.${k}` : k;
    if (!(k in parsed)) out.push(here);
    else out.push(...unknownKeys(v, parsed[k], here));
  }
  return out;
}

export interface ConfigIssue { path: string; message: string }

/** Credentials by secret path (CFG-SEC-003), each a non-empty string, as a credentials message delivers them. */
export type SecretValues = Readonly<Record<string, string>>;

export type ParsedConfigText =
  | { ok: true; config: Config; raw: unknown; ignoredSecrets: string[]; unmergedSecrets: string[] }
  | { ok: false; kind: "syntax" | "placeholder" | "schema"; issues: ConfigIssue[]; raw: unknown; ignoredSecrets: string[]; unmergedSecrets: [] };

/**
 * The pipeline on a YAML settings text (the seed example the contract tests check, settings-store STORE-IO-005): YAML parse,
 * the placeholder check, null dropping, the discarding of any value the text holds at a secret path, `ConfigSchema` validation,
 * the merge of `secrets` and the isolation `overrides`.
 *
 * `raw` is the text's tree with the secret paths removed, and `ignoredSecrets` lists the secret paths the text held a value at.
 * Secrets are merged after validation, so a credential can never supply a section the text lacks (CFG-SEC-002).
 */
// @spec CFG-LOAD-001, CFG-LOAD-007, CFG-ENV-011, CFG-SEC-002, CFG-SEC-004, CFG-SEC-011, CFG-SEC-016, CFG-SEC-017, CFG-ISO-007, MOD-CFG-012
export function parseConfigText(text: string, secrets: SecretValues = {}, overrides: IsolationOverrides = {}): ParsedConfigText {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (e) {
    // The library's message quotes the offending source line, which may hold a credential: report position and reason code only.
    const err = e as { code?: unknown; linePos?: { line: number; col: number }[] };
    const pos = err.linePos?.[0];
    const where = pos ? ` at line ${pos.line}, column ${pos.col}` : "";
    const code = typeof err.code === "string" ? ` (${err.code})` : "";
    return { ok: false, kind: "syntax", issues: [{ path: "", message: `not valid YAML${where}${code}` }], raw: undefined, ignoredSecrets: [], unmergedSecrets: [] };
  }
  const placeholders = placeholderIssues(parsed);
  if (placeholders.length) return { ok: false, kind: "placeholder", issues: placeholders, raw: undefined, ignoredSecrets: [], unmergedSecrets: [] };

  const raw = coerceEmptyNumbers(parsed);
  const ignoredSecrets: string[] = [];
  if (isObj(raw)) {
    for (const p of SECRET_PATHS) {
      for (const keys of concreteKeys(raw, p.split("."))) {
        const path = keys.join(".");
        const v = getPath(raw, path);
        if (v !== undefined && v !== "") ignoredSecrets.push(path);
        const parent = getPath(raw, keys.slice(0, -1).join("."));
        if (isObj(parent)) delete parent[keys[keys.length - 1]!];
      }
    }
  }
  const tree = isObj(raw) ? (structuredClone(raw) as Record<string, unknown>) : raw;
  if (isObj(tree)) applyIsolation(tree, overrides);

  const result = ConfigSchema.safeParse(tree);
  if (!result.success) return { ok: false, kind: "schema", issues: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })), raw, ignoredSecrets, unmergedSecrets: [] };
  const config = result.data;
  // A credential at a wildcard path merges only into an entry the validated config holds; any other is reported by path (CFG-SEC-017).
  const unmergedSecrets: string[] = [];
  for (const [p, v] of Object.entries(secrets)) {
    const pattern = secretPathOf(p);
    if (pattern === undefined || v === "") continue;
    if (pattern.includes("*") && !isObj(getPath(config, p.split(".").slice(0, -1).join(".")))) {
      unmergedSecrets.push(p);
      continue;
    }
    setPath(config as unknown as Record<string, unknown>, p, v);
  }
  return { ok: true, config, raw, ignoredSecrets, unmergedSecrets };
}
