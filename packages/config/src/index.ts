import { readFileSync, existsSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import pino from "pino";
import { writeFileAtomic } from "./atomic.js";
import { ExpressionMapSchema, CREDENTIAL_QUERY_NAMES, type Config, type ExpressionMap } from "./schema.js";
import { parseConfigText, unknownKeys, decodeIsolation, ISOLATION_ENV, type ConfigIssue } from "./pipeline.js";
import { loadSecrets } from "./secrets.js";

export * from "./schema.js";
export {
  unknownKeys, parseConfigText, ISOLATION_OVERRIDES, ISOLATION_ENV, encodeIsolation, decodeIsolation, isolationOverriddenKeys,
  type ConfigIssue, type ParsedConfigText, type SecretValues, type IsolationName, type IsolationOverrides,
} from "./pipeline.js";
export { updateSecrets } from "./secrets.js";
export { projectSecrets, type SecretUnit } from "./project.js";
export { writeFileAtomic } from "./atomic.js";
export { ollamaModels, type OllamaModels } from "./models.js";
export * from "./editor.js";
export * from "./presentation.js";
export * from "./egress.js";

/**
 * Walk up from `start` to the nearest dir containing pnpm-workspace.yaml.
 * The `dev:<service>` mise tasks and the memory one-shots run with cwd set to the package dir, so cwd alone isn't the repo root.
 */
export function findWorkspaceRoot(start = process.cwd()): string | undefined {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

// @spec CFG-DIR-001, CFG-DIR-002
export const configDir = (): string =>
  resolve(process.env.CONFIG_DIR ?? join(findWorkspaceRoot() ?? process.cwd(), "config"));

/**
 * Where services keep generated files they must remember across restarts: `COHOST_DATA_DIR`, else `data` under the
 * workspace root (cwd when there is none). Each service writes only under `<dataDir()>/<service>/`.
 */
// @spec CFG-DIR-006, CFG-DIR-007
export const dataDir = (): string =>
  resolve(process.env.COHOST_DATA_DIR ?? join(findWorkspaceRoot() ?? process.cwd(), "data"));

let cached: Config | undefined;

/**
 * Dev convenience: if a .env sits next to the config dir (repo root) and we're
 * not inside compose (which injects env itself), load it without overriding
 * anything already set. Handles `KEY=value`, `KEY="quoted value"`, comments.
 */
// @spec CFG-ENV-010
export const dotEnvPath = (): string =>
  process.env.COHOST_ENV_FILE || join(findWorkspaceRoot() ?? dirname(configDir()), ".env");

/**
 * The operator's credentials file, which the loader merges at the secret paths and never creates: `COHOST_SECRETS_FILE` when
 * set and non-empty, else `secrets/secrets.yaml` under the workspace root, else `secrets/secrets.yaml` in the parent of the
 * config directory when there is no workspace root, whatever `CONFIG_DIR` says. In a container the variable is empty and the
 * workspace root is `/app`, so the path is the unit's projection (deployment DEPLOY-SECRET-002).
 */
// @spec CFG-SEC-001, CFG-ENV-012
export const secretsPath = (): string => {
  const override = process.env.COHOST_SECRETS_FILE;
  if (override) return resolve(override);
  return join(findWorkspaceRoot() ?? dirname(configDir()), "secrets", "secrets.yaml");
};

/**
 * The secret paths (CFG-SEC-003) that `secrets.yaml` holds a value for, sorted: the read side of the secret route and the
 * settings editor, which report a credential only as set or not set. Throws the loader's error when the file cannot be used.
 */
// @spec CFG-SEC-002, MOD-CFG-005
export function setSecretPaths(file: string = secretsPath()): string[] {
  return Object.keys(loadSecrets(file).values).sort();
}

let diagnostics: Pick<Logger, "warn"> | undefined;
/** Replace (or, with `undefined`, restore) the logger the loader reports its notices and warnings through. */
// @spec CFG-LOG-001
export function setConfigLogger(l: Pick<Logger, "warn"> | undefined): void { diagnostics = l; }
const diag = (): Pick<Logger, "warn"> => (diagnostics ??= createLogger("config"));

const formatIssues = (issues: ConfigIssue[]): string => issues.map((i) => `  ${i.path || "(file)"}: ${i.message}`).join("\n");

// @spec CFG-ENV-004, CFG-ENV-005, CFG-ENV-006, CFG-ISO-008
export function loadDotEnv(file = dotEnvPath()): void {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    const rest = line.slice(eq + 1);
    let val = rest.trim();
    const q = val[0];
    const close = q === '"' || q === "'" ? val.indexOf(q, 1) : -1;
    if (close > 0 && /^\s*(#.*)?$/.test(val.slice(close + 1))) val = val.slice(1, close); // quoted, optionally followed by a comment
    else if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    else val = rest.replace(/\s+#.*$/, "").trim(); // unquoted: whitespace then `#` starts a comment (Compose env_file)
    if (key !== ISOLATION_ENV && process.env[key] === undefined) process.env[key] = val; // only the process itself can carry an override
  }
}

// @spec CFG-LOAD-001, CFG-LOAD-003, CFG-LOAD-005, CFG-LOAD-006, CFG-ENV-011, CFG-SEC-001, CFG-SEC-002, CFG-SEC-005, CFG-SEC-008, CFG-SEC-011, CFG-SEC-017, CFG-SCH-086, CFG-ISO-007, CFG-ISO-009, CFG-ISO-010, CFG-LOAD-008
export function loadConfig(force = false): Config {
  if (cached && !force) return cached;
  loadDotEnv();
  const file = ensureFromExample("config.yaml", "config.example.yaml");
  const secretsFile = secretsPath();
  const secrets = loadSecrets(secretsFile);
  if (secrets.loose) diag().warn(`[config] ${secretsFile} can be read by other users; run: chmod 600 ${secretsFile}`);
  const overrides = decodeIsolation(process.env[ISOLATION_ENV]);
  const parsed = parseConfigText(readFileSync(file, "utf8"), secrets.values, overrides);
  // One warning for every secrets.yaml path that is not merged: a non-secret key, or a token for a server config.yaml lacks (CFG-SEC-017).
  const notMerged = [...secrets.ignored, ...parsed.unmergedSecrets];
  if (notMerged.length > 0) diag().warn(`[config] ${secretsFile}: ignoring keys that are not secret keys: ${notMerged.join(", ")}`);
  if (!parsed.ok) {
    const applied = Object.keys(overrides);
    throw new Error(`Invalid ${file}:\n${formatIssues(parsed.issues)}` + (applied.length ? `\n\n(${ISOLATION_ENV} overrides applied: ${applied.join(", ")})` : ""));
  }
  if (parsed.ignoredSecrets.length > 0) diag().warn(`[config] ${file}: ignoring values at secret keys: ${parsed.ignoredSecrets.join(", ")}; credentials belong in ${secretsFile}`);
  const stray = unknownKeys(parsed.raw, parsed.config);
  if (stray.length > 0) diag().warn(`[config] ${file}: ignoring unknown keys: ${stray.join(", ")}`);
  // A credential in a query string is sent to the server on every call; the warning names the parameter, never its value (CFG-SCH-086).
  for (const [name, server] of Object.entries(parsed.config.tools.servers)) {
    const names = [...new Set([...new URL(server.url).searchParams.keys()].filter((k) => CREDENTIAL_QUERY_NAMES.includes(k)))];
    if (names.length > 0) diag().warn(`[config] ${file}: tools.servers.${name}.url has a query parameter that looks like a credential (${names.join(", ")}); its value is not shown: put the credential in tools.servers.${name}.token`);
  }
  cached = parsed.config;
  return cached;
}

/**
 * The real files in config/ (config.yaml, personality.md, expressions.yaml) are
 * yours and git-ignored; the committed *.example.* versions seed them on first
 * run (install.sh does the same copy). Returns the path to read.
 */
// @spec CFG-DIR-003, CFG-DIR-004, CFG-DIR-005
export function ensureFromExample(name: string, example: string): string {
  const file = join(configDir(), name);
  if (existsSync(file)) return file;
  const src = join(configDir(), example);
  if (!existsSync(src)) throw new Error(`No ${file} and no ${src} to seed it from`);
  copyFileSync(src, file);
  diag().warn(`[config] created ${file} from ${example} — edit it, it's git-ignored`);
  return file;
}

// @spec CFG-USR-002
export function loadExpressions(): ExpressionMap {
  const file = ensureFromExample("expressions.yaml", "expressions.example.yaml");
  const parsed = ExpressionMapSchema.safeParse(parseYaml(readFileSync(file, "utf8")) ?? {});
  if (!parsed.success) {
    throw new Error(`Invalid ${file}:\n${formatIssues(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })))}`);
  }
  return parsed.data;
}

// @spec CFG-USR-001
export function personalityPath(): string {
  return ensureFromExample("personality.md", "personality.example.md");
}
export function loadPersonality(): string {
  return readFileSync(personalityPath(), "utf8");
}
// @spec CFG-USR-013
export function savePersonality(text: string): void {
  writeFileAtomic(personalityPath(), text);
}

/** Required env var, throws a readable error if missing. */
// @spec CFG-ENV-007
export function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name} (set it in .env)`);
  return v;
}
export function envOr(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

// @spec CFG-URL-001, CFG-URL-002
export const urls = {
  redis: () => envOr("REDIS_URL", "redis://127.0.0.1:6379"),
  database: () => envOr("DATABASE_URL", "postgres://cohost:cohost@127.0.0.1:5432/cohost"),
  ollama: () => envOr("OLLAMA_URL", "http://127.0.0.1:11434"),
  tts: () => envOr("TTS_URL", "http://127.0.0.1:8880"),
  stt: () => envOr("STT_URL", "http://127.0.0.1:8000"),
  /** Voice's public base URL; loopback by default, compose overrides with `http://voice:8700`. */
  voice: () => envOr("VOICE_URL", `http://127.0.0.1:${envOr("VOICE_PORT", "8700")}`),
};

// @spec CFG-URL-004
export function createLogger(service: string) {
  return pino({ name: service, level: envOr("LOG_LEVEL", "info") });
}
export type Logger = ReturnType<typeof createLogger>;
