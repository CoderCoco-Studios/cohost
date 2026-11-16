import { afterEach } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setConfigLogger } from "../../src/index.js";

/** The repository root, where the shipped example files live. */
export const repo = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "..");

/** A config.yaml with every required section and no placeholder: the smallest file that loads. */
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

/** Call once at the top of a test file: each test starts from the environment the file started with. */
export function isolateEnv(): void {
  const initial = { ...process.env };
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in initial)) delete process.env[k];
    Object.assign(process.env, initial);
    setConfigLogger(undefined);
  });
}

/** A fresh root/config directory pair; CONFIG_DIR and COHOST_ENV_FILE point into it. `.env` goes in the root, the rest in config/. */
export function sandbox(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "cohost-cfg-"));
  const dir = join(root, "config");
  mkdirSync(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(name === ".env" ? root : dir, name), text);
  process.env.CONFIG_DIR = dir;
  process.env.COHOST_ENV_FILE = join(root, ".env");
  delete process.env.COHOST_ISOLATION;
  return dir;
}

/** A sandbox holding the shipped example files, so the loader seeds `config.yaml` from the real example. */
export function shippedSandbox(files: Record<string, string> = {}): string {
  const dir = sandbox(files);
  copyFileSync(join(repo, "config", "config.example.yaml"), join(dir, "config.example.yaml"));
  return dir;
}

/** Everything the config logger is asked to warn about while `fn` runs. */
export function captureWarnings(fn: () => void): string[] {
  const out: string[] = [];
  setConfigLogger({ warn: ((...a: unknown[]) => { out.push(a.map(String).join(" ")); }) as never });
  try { fn(); } finally { setConfigLogger(undefined); }
  return out;
}
