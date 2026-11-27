import { afterEach } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setConfigLogger, parseYaml, loadConfig, SECTION_PATHS, type Config, type LoadOptions } from "../../src/index.js";

/** The repository root, where the shipped example files live. */
export const repo = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "..");

/** Settings with every required section and no placeholder: the smallest settings that load. */
export const MINIMAL_YAML = `cohost: { name: Coco, streamer: Chris }
llm: { model: m, embed_model: e }
vision: { model: v, obs: {} }
chat: { twitch: {} }
brain: {}
voice: {}
avatar: { vtube_studio: {}, vmc: {} }
ears: {}
dashboard: {}
`;

/** The shipped settings example's text. */
export const exampleYaml = (): string => readFileSync(join(repo, "config", "config.example.yaml"), "utf8");

/** Call once at the top of a test file: each test starts from the environment the file started with. */
export function isolateEnv(): void {
  const initial = { ...process.env };
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in initial)) delete process.env[k];
    Object.assign(process.env, initial);
    setConfigLogger(undefined);
  });
}

/**
 * A fresh root/config directory pair; CONFIG_DIR and COHOST_ENV_FILE point into it. `.env` goes in the root, the rest in
 * config/.
 */
export function sandbox(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "cohost-cfg-"));
  const dir = join(root, "config");
  mkdirSync(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(name === ".env" ? join(root, name) : join(dir, name), text);
  process.env.CONFIG_DIR = dir;
  process.env.COHOST_ENV_FILE = join(root, ".env");
  delete process.env.COHOST_ISOLATION;
  return dir;
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

/**
 * A settings tree split into stored sections by their dotted path (CFG-PRES), as the settings store holds them: every declared
 * section, `null` where the tree holds none. A top-level key, or a key of `brain`, that is no section is kept as a stray section
 * under its own path, so the loader reports it as an unknown key.
 */
export function sectionsOf(tree: unknown): Record<string, unknown> {
  const t = isObj(tree) ? tree : {};
  const out: Record<string, unknown> = {};
  for (const path of SECTION_PATHS) {
    const v = path.split(".").reduce<unknown>((o, k) => (isObj(o) ? o[k] : undefined), t);
    out[path] = v === undefined ? null : v;
  }
  for (const [k, v] of Object.entries(t)) {
    if (k === "brain" && isObj(v)) {
      for (const [sub, sv] of Object.entries(v)) if (!SECTION_PATHS.includes(`brain.${sub}`)) out[`brain.${sub}`] = sv;
    } else if (!SECTION_PATHS.includes(k) && k !== "brain") out[k] = v;
  }
  return out;
}

/**
 * A projection directory (settings-store STORE-PROJ-002) whose `settings.json` holds, for `unit` (default `test`), every
 * section of the YAML settings `text` and the given documents.
 */
export function projectionDir(text: string, opts: { unit?: string; documents?: Record<string, unknown> } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "cohost-proj-"));
  const projection = { format: 1, unit: opts.unit ?? "test", revision: 1, sections: sectionsOf(parseYaml(text)), documents: opts.documents ?? {} };
  writeFileSync(join(dir, "settings.json"), JSON.stringify(projection));
  return dir;
}

/** `loadConfig` on a fresh projection of the YAML settings `text` holding every section, read anew (never the cache). */
export function loadSettings(text: string, opts: Omit<LoadOptions, "dir" | "force"> = {}): Config {
  return loadConfig({ ...opts, dir: projectionDir(text), force: true });
}

/** Everything the config logger is asked to warn about while `fn` runs. */
export function captureWarnings(fn: () => void): string[] {
  const out: string[] = [];
  setConfigLogger({ warn: ((...a: unknown[]) => { out.push(a.map(String).join(" ")); }) as never });
  try { fn(); } finally { setConfigLogger(undefined); }
  return out;
}
