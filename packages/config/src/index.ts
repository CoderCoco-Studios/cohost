import { readFileSync, writeFileSync, existsSync, copyFileSync, renameSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve, basename } from "node:path";
import { parse as parseYaml } from "yaml";
import pino from "pino";
import { ExpressionMapSchema, type Config, type ExpressionMap } from "./schema.js";
import { parseConfigText, unknownKeys, type ConfigIssue } from "./pipeline.js";

export * from "./schema.js";
export { substituteEnv, unknownKeys, parseConfigText, type ConfigIssue, type ParsedConfigText } from "./pipeline.js";
export * from "./editor.js";

/**
 * Walk up from `start` to the nearest dir containing pnpm-workspace.yaml.
 * `pnpm dev` runs scripts with cwd set to the package dir, so cwd alone isn't the repo root.
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

/** True when a dev run has no .env (compose injects env itself, so containers, per `inContainer`, are exempt). */
// @spec CFG-ENV-010, CFG-LOAD-004
export const missingDotEnv = (inContainer: () => boolean = () => existsSync("/.dockerenv")): boolean =>
  !existsSync(dotEnvPath()) && !inContainer();

let diagnostics: Pick<Logger, "warn"> | undefined;
/** Replace (or, with `undefined`, restore) the logger the loader reports its notices and warnings through. */
// @spec CFG-LOG-001
export function setConfigLogger(l: Pick<Logger, "warn"> | undefined): void { diagnostics = l; }
const diag = (): Pick<Logger, "warn"> => (diagnostics ??= createLogger("config"));

const formatIssues = (issues: ConfigIssue[]): string => issues.map((i) => `  ${i.path || "(file)"}: ${i.message}`).join("\n");

// @spec CFG-ENV-004, CFG-ENV-005, CFG-ENV-006
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
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

// @spec CFG-LOAD-001, CFG-LOAD-003, CFG-LOAD-004, CFG-LOAD-005, CFG-LOAD-006
export function loadConfig(force = false): Config {
  if (cached && !force) return cached;
  loadDotEnv();
  const file = ensureFromExample("config.yaml", "config.example.yaml");
  const parsed = parseConfigText(readFileSync(file, "utf8"));
  if (!parsed.ok) {
    throw new Error(
      `Invalid ${file}:\n${formatIssues(parsed.issues)}` +
      (missingDotEnv() ? `\n\nNo .env found at ${dotEnvPath()} — ${"${VAR}"} values in config.yaml came out empty. Run: cp .env.example .env` : ""),
    );
  }
  const stray = unknownKeys(parsed.raw, parsed.config);
  if (stray.length > 0) diag().warn(`[config] ${file}: ignoring unknown keys: ${stray.join(", ")}`);
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

/**
 * Replace `file` with `text` through a temporary file in the same directory and a rename, so a failed write leaves the
 * previous file whole. Shared by `savePersonality` and the settings editor's section writer.
 */
// @spec CFG-USR-013, MOD-CFG-014
export function writeFileAtomic(file: string, text: string): void {
  const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, file);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* the temp file was never created */ }
    throw e;
  }
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

// @spec CFG-URL-001, CFG-URL-002, CFG-URL-003
export const urls = {
  redis: () => envOr("REDIS_URL", "redis://127.0.0.1:6379"),
  database: () => envOr("DATABASE_URL", "postgres://cohost:cohost@127.0.0.1:5432/cohost"),
  ollama: () => envOr("OLLAMA_URL", "http://127.0.0.1:11434"),
  tts: () => envOr("TTS_URL", "http://127.0.0.1:8880"),
  stt: () => envOr("STT_URL", "http://127.0.0.1:8000"),
  /** Voice's public base URL; loopback by default, compose overrides with `http://voice:8700`. */
  voice: () => envOr("VOICE_URL", `http://127.0.0.1:${envOr("VOICE_PORT", "8700")}`),
  /** Dashboard base URL; eyes/ears fetch injected uploads from `<dashboard>/uploads/`. */
  dashboard: () => envOr("DASHBOARD_URL", "http://127.0.0.1:3000"),
};

// @spec CFG-URL-004
export function createLogger(service: string) {
  return pino({ name: service, level: envOr("LOG_LEVEL", "info") });
}
export type Logger = ReturnType<typeof createLogger>;
