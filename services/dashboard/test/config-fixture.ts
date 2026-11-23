// A config.yaml for tests that make the dashboard's loader (CONFIG_DIR) read a chosen configuration: the committed example
// with some section keys replaced through the editor, so the file is complete (the loader needs every required section).
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { applySection } from "@cohost/config";

const repo = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
export const EXAMPLE = readFileSync(join(repo, "config", "config.example.yaml"), "utf8");

/** `{section: {key: value}}`, keys relative to the section (`openai.base_url` under `voice`). */
export type Edits = Record<string, Record<string, unknown>>;

/** The example with `edits` applied; throws when the editor refuses one. */
export function configText(edits: Edits = {}): string {
  let text = EXAMPLE;
  for (const [section, values] of Object.entries(edits)) {
    const r = applySection(text, section, values);
    if (!r.ok) throw new Error(`fixture: ${JSON.stringify(r.issues)}`);
    text = r.text;
  }
  return text;
}

/** A fresh config directory holding `config.yaml` (and `secrets.yaml` when given, mode 0600). */
export function configDir(text: string, secrets?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cohost-cfg-"));
  writeFileSync(join(dir, "config.yaml"), text);
  if (secrets !== undefined) writeFileSync(join(dir, "secrets.yaml"), secrets, { mode: 0o600 });
  return dir;
}

/** Points the loader at `dir` until `fn` settles; the previous values come back after. */
export async function withConfigDir<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const prev = { c: process.env["CONFIG_DIR"], e: process.env["COHOST_ENV_FILE"] };
  process.env["CONFIG_DIR"] = dir;
  process.env["COHOST_ENV_FILE"] = join(dir, "no.env");
  try { return await fn(); } finally {
    for (const [k, v] of [["CONFIG_DIR", prev.c], ["COHOST_ENV_FILE", prev.e]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
