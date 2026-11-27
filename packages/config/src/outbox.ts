/**
 * The reflection pass's personality outbox (settings-store STORE-OUT-001): `reflect` cannot write the settings store, so it
 * leaves the whole new personality text here with the SHA-256 of the text it started from, and a store-owning program applies
 * it when the stored document still has that hash (STORE-OUT-002).
 */
import { mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.js";
import { dataDir } from "./paths.js";

/** The outbox's content: `base` the SHA-256 (hex) of the personality the pass read, `text` the whole new personality. */
export interface PersonalityOutbox { base: string; text: string }

/** The SHA-256 of a text's UTF-8 bytes, as lower-case hex. */
export const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** `<data>/memory/personality-outbox.json`. */
export const outboxPath = (data: string = dataDir()): string => join(data, "memory", "personality-outbox.json");

/**
 * Writes `{base, text}` to the outbox with mode 0600 through a rename, `base` the SHA-256 of `readText`, the personality the
 * pass read from its projection, and `text` the new whole text. Returns the file written.
 */
// @spec STORE-OUT-001
export function writePersonalityOutbox(readText: string, text: string, data: string = dataDir()): string {
  const file = outboxPath(data);
  mkdirSync(join(data, "memory"), { recursive: true, mode: 0o700 });
  const outbox: PersonalityOutbox = { base: sha256Hex(readText), text };
  writeFileAtomic(file, `${JSON.stringify(outbox)}\n`, { mode: 0o600 });
  return file;
}

/** The outbox at `file` (default the outbox path), or undefined when there is none; one that is not `{base, text}` throws naming the file. */
// @spec STORE-OUT-002
export function readPersonalityOutbox(data: string = dataDir(), file: string = outboxPath(data)): PersonalityOutbox | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { raw = undefined; }
  const o = raw as Partial<PersonalityOutbox> | undefined;
  if (!o || typeof o !== "object" || typeof o.base !== "string" || !/^[0-9a-f]{64}$/.test(o.base) || typeof o.text !== "string") {
    throw new Error(`${file} is not a personality outbox ({base, text})`);
  }
  return { base: o.base, text: o.text };
}
