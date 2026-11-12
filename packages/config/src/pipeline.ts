import { parse as parseYaml } from "yaml";
import { ConfigSchema, type Config } from "./schema.js";

/**
 * Replace ${VAR} with env.VAR (empty string when unset), and
 * ${VAR:-default} with the default when VAR is unset or empty. The default
 * form lets config.yaml hold the normal value literally while still allowing
 * a per-machine override from .env.
 */
// @spec CFG-ENV-001, CFG-ENV-002, CFG-ENV-003
export function substituteEnv(text: string, env: NodeJS.ProcessEnv = process.env): string {
  return text.replace(/\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g, (_, k: string, def: string | undefined) => {
    const v = env[k];
    if (v !== undefined && v !== "") return v;
    return def ?? "";
  });
}

// @spec CFG-LOAD-002
export function coerceEmptyNumbers(raw: unknown): unknown {
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

/** Keys present in the yaml that the schema doesn't know (typos, retired settings), including inside array entries as `path[index].key`. */
export function unknownKeys(raw: unknown, parsed: unknown, path = ""): string[] {
  const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
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

export type ParsedConfigText =
  | { ok: true; config: Config; raw: unknown }
  | { ok: false; issues: ConfigIssue[]; raw: unknown };

/**
 * The loader's pipeline on a text: substitution from `env`, YAML parse, null dropping and `ConfigSchema` validation.
 * `loadConfig` and the settings editor both run it, so they accept exactly the same files.
 */
// @spec CFG-LOAD-001, MOD-CFG-012
export function parseConfigText(text: string, env: NodeJS.ProcessEnv = process.env): ParsedConfigText {
  let raw: unknown;
  try {
    raw = coerceEmptyNumbers(parseYaml(substituteEnv(text, env)));
  } catch (e) {
    return { ok: false, issues: [{ path: "", message: `not valid YAML: ${(e as Error).message}` }], raw: undefined };
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })), raw };
  return { ok: true, config: parsed.data, raw };
}
