/**
 * The YAML files of the settings before the settings store: `config/config.yaml`, `personality.md`, `expressions.yaml` and
 * `secrets/secrets.yaml`. Only the dashboard still reads and writes them until its own cut-over to the store (step 3b of #372);
 * no service, the control plane or the store reads them. This module goes away with that cut-over.
 */
import { readFileSync, existsSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { writeFileAtomic } from "./atomic.js";
import { ExpressionMapSchema, CREDENTIAL_QUERY_NAMES, type Config, type ExpressionMap } from "./schema.js";
import { parseConfigText, unknownKeys, decodeIsolation, ISOLATION_ENV, type ConfigIssue } from "./pipeline.js";
import { loadSecrets } from "./secrets.js";
import { configDir, findWorkspaceRoot, loadDotEnv } from "./paths.js";
import { diag } from "./diag.js";
import { ConfigError, bracketIndexes, type ConfigProblem } from "./errors.js";
import { EARS_VERIFIER_PATH } from "./projection.js";

let cached: Config | undefined;

/**
 * The operator's credentials file, which the loader merges at the secret paths and never creates: `COHOST_SECRETS_FILE` when
 * set and non-empty, else `secrets/secrets.yaml` under the workspace root, else `secrets/secrets.yaml` in the parent of the
 * config directory when there is no workspace root, whatever `CONFIG_DIR` says. In a container the variable is empty and the
 * workspace root is `/app`, so the path is the unit's projection (deployment DEPLOY-SECRET-002).
 */
export const secretsPath = (): string => {
  const override = process.env.COHOST_SECRETS_FILE;
  if (override) return resolve(override);
  return join(findWorkspaceRoot() ?? dirname(configDir()), "secrets", "secrets.yaml");
};

/**
 * The secret paths (CFG-SEC-003) that `secrets.yaml` holds a value for, sorted: the read side of the secret route and the
 * settings editor, which report a credential only as set or not set. Throws the loader's error when the file cannot be used.
 */
export function setSecretPaths(file: string = secretsPath()): string[] {
  return Object.keys(loadSecrets(file).values).toSorted();
}


const formatIssues = (issues: ConfigIssue[]): string => issues.map((i) => `  ${i.path || "(file)"}: ${i.message}`).join("\n");

export function loadConfigFile(force = false): Config {
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
    throw new ConfigError(`Invalid ${file}:\n${formatIssues(parsed.issues)}` + (applied.length ? `\n\n(${ISOLATION_ENV} overrides applied: ${applied.join(", ")})` : ""), problemsOf(file, parsed));
  }
  if (parsed.ignoredSecrets.length > 0) diag().warn(`[config] ${file}: ignoring values at secret keys: ${parsed.ignoredSecrets.join(", ")}; credentials belong in ${secretsFile}`);
  const stray = unknownKeys(parsed.raw, parsed.config);
  if (stray.length > 0) diag().warn(`[config] ${file}: ignoring unknown keys: ${stray.join(", ")}`);
  // A credential in a query string is sent to the server on every call; the warning names the parameter, never its value (CFG-SCH-086).
  for (const [name, server] of Object.entries(parsed.config.tools.servers)) {
    const names = [...new Set([...new URL(server.url).searchParams.keys()].filter((k) => CREDENTIAL_QUERY_NAMES.includes(k)))];
    if (names.length > 0) diag().warn(`[config] ${file}: tools.servers.${name}.url has a query parameter that looks like a credential (${names.join(", ")}); its value is not shown: put the credential in tools.servers.${name}.token`);
  }
  // The derived ears listener key (CFG-SEC-020): merged when well formed; any other value is dropped with one warning naming the path.
  for (const p of secrets.badDerived) diag().warn(`[config] ${secretsFile}: ignoring ${p}: it is not 64 lowercase hex digits, so the ears audio listener has no key`);
  const verifier = secrets.derived[EARS_VERIFIER_PATH];
  if (verifier !== undefined) (parsed.config.ears.http as { verifier?: string }).verifier = verifier;
  cached = parsed.config;
  return cached;
}


/** The problems of a failed parse of `config.yaml`, as `ConfigError` carries them (list indexes written `[i]`). */
const problemsOf = (file: string, parsed: Extract<ReturnType<typeof parseConfigText>, { ok: false }>): ConfigProblem[] =>
  parsed.issues.map((i) => ({ file, path: bracketIndexes(i.path), message: i.message, kind: parsed.kind }));

/**
 * Every problem of `secrets.yaml` and `config.yaml` as the loader would meet them, secrets first, read fresh: no cache, no
 * warning, no isolation override. `config.yaml` is validated with the secrets that could be read (none when `secrets.yaml`
 * itself fails). Empty when `loadConfig(true)` would succeed; a failure that is not about the files' content is thrown. The
 * files default to the loader's, and `configText` stands in for the text of `config.yaml` (an edit not yet written); the
 * dashboard's recovery screen and the control plane's config gate call it.
 */
export function checkConfig(files: { configFile?: string; secretsFile?: string; configText?: string } = {}): ConfigProblem[] {
  const file = files.configFile ?? ensureFromExample("config.yaml", "config.example.yaml");
  const problems: ConfigProblem[] = [];
  let values: Readonly<Record<string, string>> = {};
  try {
    values = loadSecrets(files.secretsFile ?? secretsPath()).values;
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    problems.push(...e.problems);
  }
  const parsed = parseConfigText(files.configText ?? readFileSync(file, "utf8"), values);
  if (!parsed.ok) problems.push(...problemsOf(file, parsed));
  return problems;
}

/**
 * The real files in config/ (config.yaml, personality.md, expressions.yaml) are
 * yours and git-ignored; the committed *.example.* versions seed them on first
 * run (install.sh does the same copy). Returns the path to read.
 */
export function ensureFromExample(name: string, example: string): string {
  const file = join(configDir(), name);
  if (existsSync(file)) return file;
  const src = join(configDir(), example);
  if (!existsSync(src)) throw new Error(`No ${file} and no ${src} to seed it from`);
  copyFileSync(src, file);
  diag().warn(`[config] created ${file} from ${example} — edit it, it's git-ignored`);
  return file;
}

export function loadExpressionsFile(): ExpressionMap {
  const file = ensureFromExample("expressions.yaml", "expressions.example.yaml");
  const parsed = ExpressionMapSchema.safeParse(parseYaml(readFileSync(file, "utf8")) ?? {});
  if (!parsed.success) {
    throw new Error(`Invalid ${file}:\n${formatIssues(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })))}`);
  }
  return parsed.data;
}

export function personalityPath(): string {
  return ensureFromExample("personality.md", "personality.example.md");
}
export function loadPersonalityFile(): string {
  return readFileSync(personalityPath(), "utf8");
}
export function savePersonality(text: string): void {
  writeFileAtomic(personalityPath(), text);
}

