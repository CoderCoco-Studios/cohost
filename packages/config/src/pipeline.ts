import { parse as parseYaml } from "yaml";
import { ConfigSchema, SECRET_PATHS, type Config } from "./schema.js";

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

// ---------- isolation overrides

/** The one environment variable that can change a setting: set by the control plane for an isolated start of one unit. */
export const ISOLATION_ENV = "COHOST_ISOLATION";

/**
 * The thirteen override names `COHOST_ISOLATION` may carry, each mapped to the key path it overrides. They are labels in
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

/** Sets each override at its key path; a value that parses to nothing removes the key so the schema default applies. */
function applyIsolation(tree: Record<string, unknown>, overrides: IsolationOverrides): void {
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

/** One issue per `${NAME}` or `${NAME:-default}` placeholder in a string value, at the key's dotted path (an array entry as `path[index]`). */
function placeholderIssues(raw: unknown, path = ""): ConfigIssue[] {
  if (typeof raw === "string") {
    return [...raw.matchAll(PLACEHOLDER)].map((m) => ({
      path,
      message: `uses the placeholder \${${m[1]}}; ${SECRET_PATHS.includes(path) ? "write the credential in secrets.yaml" : "write the value as a literal in config.yaml"} (\${...} is not supported in config.yaml and no environment variable is substituted; there is no escape, so to keep this text literal write the name in lower-case or reword it)`,
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

/** Credentials by secret path (CFG-SEC-003), each a non-empty string, as `secrets.yaml` holds them. */
export type SecretValues = Readonly<Record<string, string>>;

export type ParsedConfigText =
  | { ok: true; config: Config; raw: unknown; ignoredSecrets: string[] }
  | { ok: false; issues: ConfigIssue[]; raw: unknown; ignoredSecrets: string[] };

/**
 * The loader's pipeline on a text: YAML parse, the placeholder check, null dropping, the discarding of any value `config.yaml`
 * holds at a secret path, `ConfigSchema` validation, the merge of `secrets` and the isolation `overrides`. `loadConfig` and the
 * settings editor both run it, so they accept exactly the same files; the editor passes no overrides.
 *
 * `raw` is the file's tree with the secret paths removed, and `ignoredSecrets` lists the secret paths the file held a value at.
 * Secrets are merged into the config after validation, so a credential can never supply a section the file lacks (CFG-SEC-002).
 */
// @spec CFG-LOAD-001, CFG-LOAD-007, CFG-ENV-011, CFG-SEC-002, CFG-SEC-004, CFG-SEC-011, CFG-ISO-007, MOD-CFG-012
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
    return { ok: false, issues: [{ path: "", message: `not valid YAML${where}${code}` }], raw: undefined, ignoredSecrets: [] };
  }
  const placeholders = placeholderIssues(parsed);
  if (placeholders.length) return { ok: false, issues: placeholders, raw: undefined, ignoredSecrets: [] };

  const raw = coerceEmptyNumbers(parsed);
  const ignoredSecrets: string[] = [];
  if (isObj(raw)) {
    for (const p of SECRET_PATHS) {
      const v = getPath(raw, p);
      if (v !== undefined && v !== "") ignoredSecrets.push(p);
      const parent = getPath(raw, p.split(".").slice(0, -1).join("."));
      if (isObj(parent)) delete parent[p.split(".").pop()!];
    }
  }
  const tree = isObj(raw) ? (structuredClone(raw) as Record<string, unknown>) : raw;
  if (isObj(tree)) applyIsolation(tree, overrides);

  const result = ConfigSchema.safeParse(tree);
  if (!result.success) return { ok: false, issues: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })), raw, ignoredSecrets };
  const config = result.data;
  for (const [p, v] of Object.entries(secrets)) {
    if (SECRET_PATHS.includes(p) && v !== "") setPath(config as unknown as Record<string, unknown>, p, v);
  }
  return { ok: true, config, raw, ignoredSecrets };
}
