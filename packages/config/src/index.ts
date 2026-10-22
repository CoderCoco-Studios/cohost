import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import pino from "pino";
import { ConfigSchema, ExpressionMapSchema, type Config, type ExpressionMap } from "./schema.js";

export * from "./schema.js";

export const configDir = (): string =>
  resolve(process.env.CONFIG_DIR ?? join(process.cwd(), "config"));

/**
 * Replace ${VAR} with process.env.VAR (empty string when unset), and
 * ${VAR:-default} with the default when VAR is unset or empty. The default
 * form lets config.yaml hold the normal value literally while still allowing
 * a per-machine override from .env.
 */
export function substituteEnv(text: string): string {
  return text.replace(/\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g, (_, k: string, def: string | undefined) => {
    const v = process.env[k];
    if (v !== undefined && v !== "") return v;
    return def ?? "";
  });
}

function coerceEmptyNumbers(raw: unknown): unknown {
  // YAML like `port: ${OBS_PORT}` becomes `port: ` (null) when the var is unset. Leave it to defaults.
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

let cached: Config | undefined;

/**
 * Dev convenience: if a .env sits next to the config dir (repo root) and we're
 * not inside compose (which injects env itself), load it without overriding
 * anything already set. Handles `KEY=value`, `KEY="quoted value"`, comments.
 */
export function loadDotEnv(file = join(configDir(), "..", ".env")): void {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

/** Keys present in the yaml that the schema doesn't know (typos, or settings from before the region split). */
export function unknownKeys(raw: unknown, parsed: unknown, path = ""): string[] {
  const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
  if (!isObj(raw) || !isObj(parsed)) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(raw)) {
    const here = path ? `${path}.${k}` : k;
    if (!(k in parsed)) out.push(here);
    else out.push(...unknownKeys(v, parsed[k], here));
  }
  return out;
}

export function loadConfig(force = false): Config {
  if (cached && !force) return cached;
  loadDotEnv();
  const file = ensureFromExample("config.yaml", "config.example.yaml");
  const raw = parseYaml(substituteEnv(readFileSync(file, "utf8")));
  const parsed = ConfigSchema.safeParse(coerceEmptyNumbers(raw));
  if (!parsed.success) {
    throw new Error(`Invalid ${file}:\n${parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  }
  const stray = unknownKeys(coerceEmptyNumbers(raw), parsed.data);
  if (stray.length > 0) {
    console.warn(
      `[config] ${file}: ignoring unknown keys: ${stray.join(", ")}. ` +
      `(Settings that used to sit directly under brain: moved into brain.salience / affect / memory / cortex — see config.example.yaml.)`,
    );
  }
  cached = parsed.data;
  return cached;
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
  console.warn(`[config] created ${file} from ${example} — edit it, it's git-ignored`);
  return file;
}

export function loadExpressions(): ExpressionMap {
  const file = ensureFromExample("expressions.yaml", "expressions.example.yaml");
  return ExpressionMapSchema.parse(parseYaml(readFileSync(file, "utf8")) ?? {});
}

export function personalityPath(): string {
  return ensureFromExample("personality.md", "personality.example.md");
}
export function loadPersonality(): string {
  return readFileSync(personalityPath(), "utf8");
}
export function savePersonality(text: string): void {
  writeFileSync(personalityPath(), text, "utf8");
}

/** Required env var, throws a readable error if missing. */
export function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name} (set it in .env)`);
  return v;
}
export function envOr(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

export const urls = {
  redis: () => envOr("REDIS_URL", "redis://127.0.0.1:6379"),
  database: () => envOr("DATABASE_URL", "postgres://cohost:cohost@127.0.0.1:5432/cohost"),
  ollama: () => envOr("OLLAMA_URL", "http://127.0.0.1:11434"),
  tts: () => envOr("TTS_URL", "http://127.0.0.1:8880"),
  stt: () => envOr("STT_URL", "http://127.0.0.1:8000"),
};

export function createLogger(service: string) {
  return pino({ name: service, level: envOr("LOG_LEVEL", "info") });
}
export type Logger = ReturnType<typeof createLogger>;
