/**
 * Runtime credentials a service persists under its data directory (chat's refreshed Twitch token, avatar's VTube Studio plugin
 * token), encrypted under the unit's state key from its credentials message (settings-store STORE-STATE-002), so no credential
 * is on disk in plaintext.
 */
import { readFileSync } from "node:fs";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { basename } from "node:path";
import { writeFileAtomic, type Logger } from "@cohost/config";

const VERSION = "cohost-state-v1";

/** The associated data binding a state file's content to its unit and file name. */
export const stateAad = (unit: string, name: string): Buffer => Buffer.from(`cohost/state/v1|${unit}|${name}`, "utf8");

const checkKey = (key: Buffer): void => {
  if (key.length !== 32) throw new Error("a state key is 32 bytes");
};

/**
 * Encrypts `text` with AES-256-GCM under `key` with a new random nonce and the associated data `cohost/state/v1|<unit>|<file
 * name>`, and writes it to `file` with mode 0600 through a rename.
 */
// @spec STORE-STATE-002
export function writeStateFile(file: string, unit: string, key: Buffer, text: string): void {
  checkKey(key);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(stateAad(unit, basename(file)));
  const ciphertext = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  writeFileAtomic(file, `${[VERSION, nonce, tag, ciphertext].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(".")}\n`, { mode: 0o600 });
}

/**
 * The text of a state file, or undefined when there is none or it cannot be decrypted under `key` for this unit and file name
 * (another key, another unit, a renamed or damaged file); that case logs one warning naming the file, never its content.
 */
// @spec STORE-STATE-002
export function readStateFile(file: string, unit: string, key: Buffer, log?: Pick<Logger, "warn">): string | undefined {
  checkKey(key);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  const parts = text.trim().split(".");
  try {
    if (parts.length !== 4 || parts[0] !== VERSION) throw new Error("not a state file");
    const [nonce, tag, ciphertext] = parts.slice(1).map((p) => Buffer.from(p, "base64url")) as [Buffer, Buffer, Buffer];
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(stateAad(unit, basename(file)));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    log?.warn({ file }, `ignoring ${file}: it does not decrypt under this unit's state key, so it counts as absent`);
    return undefined;
  }
}
