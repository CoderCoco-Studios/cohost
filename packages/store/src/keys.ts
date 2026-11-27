import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { closeSync, fstatSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { StoreError } from "./errors.js";

/** The prefix of the key file's one line, and of the recovery key, which is the same text (STORE-KEY-001). */
export const KEY_PREFIX = "cohost-key-1:";
const KEY_BYTES = 32;

/** The key file's text for `key`: `cohost-key-1:` and the key in base64url without padding. */
export const formatKey = (key: Buffer): string => `${KEY_PREFIX}${key.toString("base64url")}`;

/** The 32-byte key a key file's text or a recovery key holds, or undefined when the text is not of that form. */
export function parseKey(text: string): Buffer | undefined {
  const t = text.trim();
  if (!t.startsWith(KEY_PREFIX)) return undefined;
  const body = t.slice(KEY_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(body)) return undefined;
  const key = Buffer.from(body, "base64url");
  return key.length === KEY_BYTES && key.toString("base64url") === body ? key : undefined;
}

/** The key id: the first 16 lowercase hex digits of HMAC-SHA256 keyed with the key of `cohost/key-id/v1` (STORE-KEY-004). */
// @spec STORE-KEY-004
export const keyId = (key: Buffer): string => createHmac("sha256", key).update("cohost/key-id/v1").digest("hex").slice(0, 16);

/** Whether mode checks apply: not on Windows, and not where the filesystem reports 0777 for every file (a drvfs checkout). */
const modeChecked = (mode: number): boolean => process.platform !== "win32" && (mode & 0o777) !== 0o777;

/** Whether `mode` grants any permission to group or other, where modes are checked. */
export const looseMode = (mode: number): boolean => modeChecked(mode) && (mode & 0o077) !== 0;
/** Whether `mode` lets group or other write, where modes are checked. */
export const writableByOthers = (mode: number): boolean => modeChecked(mode) && (mode & 0o022) !== 0;

/**
 * Refuses a directory group or other can write (someone else could swap the files in it), naming it and `chmod 700`; does
 * nothing when it does not exist.
 */
export function checkPrivateDir(dir: string, what: string): void {
  let mode: number;
  try { mode = statSync(dir).mode; } catch { return; }
  if (writableByOthers(mode)) throw new StoreError("key-mode", `the ${what} directory ${dir} can be written by other users; run: chmod 700 ${dir}`);
}

/**
 * Reads the master key from `file`: undefined when the file does not exist. A file that grants group or other any permission is
 * refused (STORE-KEY-005), and one that does not hold a well-formed key is refused as the wrong key.
 */
// @spec STORE-KEY-005
export function readKeyFile(file: string): Buffer | undefined {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  let text: string;
  try {
    // One descriptor for the mode check and the read, so the file checked is the file read.
    if (looseMode(fstatSync(fd).mode)) throw new StoreError("key-mode", `the master key file ${file} can be read by other users; run: chmod 600 ${file}`);
    text = readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
  const key = parseKey(text);
  if (!key) throw new StoreError("key-wrong", `the master key file ${file} does not hold a key of the form ${KEY_PREFIX}<base64url>`);
  return key;
}

const sleep = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

const tempIn = (file: string): string => join(dirname(file), `.${basename(file)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);

/**
 * Writes `key` as `file` so the file appears whole or not at all (STORE-KEY-002): the directory with mode 0700 when missing, a
 * temporary file with mode 0600 in it, then `link()` to the key file's name, removing the temporary file either way. Returns
 * false, writing nothing, when the key file already exists.
 */
export function linkKeyFile(file: string, key: Buffer): boolean {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = tempIn(file);
  writeFileSync(tmp, `${formatKey(key)}\n`, { flag: "wx", mode: 0o600 });
  try {
    linkSync(tmp, file);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  } finally {
    try { unlinkSync(tmp); } catch { /* already gone */ }
  }
}

/**
 * Creates the master key file with a new random key, or, when another program created it first, reads that program's key,
 * retrying for up to 2 s until it is well formed (STORE-KEY-002). Returns the key and whether this call made it.
 */
// @spec STORE-KEY-002
export function createKeyFile(file: string): { key: Buffer; created: boolean } {
  const key = randomBytes(KEY_BYTES);
  if (linkKeyFile(file, key)) return { key, created: true };
  const until = Date.now() + 2000;
  for (;;) {
    try {
      const theirs = readKeyFile(file);
      if (theirs) return { key: theirs, created: false };
    } catch (e) {
      if (!(e instanceof StoreError) || e.kind !== "key-wrong" || Date.now() > until) throw e;
    }
    if (Date.now() > until) throw new StoreError("key-missing", `the master key file ${file} disappeared while it was being read`);
    sleep(50);
  }
}

/** Stages a replacement key file: a temporary file with mode 0600 beside it, renamed over it by `commit` (STORE-KEY-007). */
export function stageKeyFile(file: string, key: Buffer): { path: string; commit(): void; abort(): void } {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = tempIn(file);
  writeFileSync(tmp, `${formatKey(key)}\n`, { flag: "wx", mode: 0o600 });
  return {
    path: tmp,
    commit: () => renameSync(tmp, file),
    abort: () => { try { unlinkSync(tmp); } catch { /* already gone */ } },
  };
}

/** A value encrypted under the master key: the 12-byte nonce, the 16-byte GCM tag and the ciphertext. */
export interface Sealed { nonce: Buffer; tag: Buffer; ciphertext: Buffer }

/** The associated data binding a value to its store, table and path or name (STORE-KEY-006). */
export const aadOf = (storeId: string, table: string, name: string): Buffer => Buffer.from(`cohost/v1|${storeId}|${table}|${name}`, "utf8");

/** AES-256-GCM with a new random 12-byte nonce. */
// @spec STORE-KEY-006
export function seal(key: Buffer, aad: Buffer, plain: Buffer): Sealed {
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, nonce);
  c.setAAD(aad);
  const ciphertext = Buffer.concat([c.update(plain), c.final()]);
  return { nonce, tag: c.getAuthTag(), ciphertext };
}

/** Decrypts a sealed value; undefined when authentication fails (a wrong key, a tampered or moved row). */
export function open(key: Buffer, aad: Buffer, s: Sealed): Buffer | undefined {
  try {
    const d = createDecipheriv("aes-256-gcm", key, s.nonce);
    d.setAAD(aad);
    d.setAuthTag(s.tag);
    return Buffer.concat([d.update(s.ciphertext), d.final()]);
  } catch {
    return undefined;
  }
}

/**
 * Where the recovery-key notice goes: standard output when it is a terminal (`write`), and the pointer that replaces the key
 * otherwise on standard error (`warn`), so a redirected standard output (`config:export > file`) never receives it.
 */
export interface NoticeOut { isTTY?: boolean | undefined; write(text: string): unknown; warn(text: string): unknown }

/**
 * Prints the recovery-key notice for a key this program created (STORE-KEY-002): to a terminal, the key and why to keep it;
 * otherwise only that one was created and how to see it. Never through a logger or the bus. Returns whether the key was shown.
 */
// @spec STORE-KEY-002
export function recoveryNotice(out: NoticeOut, key: Buffer, headline = "cohost created a new master key."): boolean {
  if (out.isTTY) {
    out.write(`${headline} Its recovery key is:\n\n  ${formatKey(key)}\n\n` +
      "It is the only way to recover the stored credentials if the key file is lost: keep it in a password manager.\n");
    return true;
  }
  out.warn("a recovery key was created; run mise run config:key -- --show\n");
  return false;
}
