/**
 * The service side of credential delivery (settings-store STORE-DLV-004, shared-runtime SHARED-BOOT-010): the control plane
 * hands a unit its credentials in one message, in memory, and `receiveCredentials` takes it in. A container's message arrives
 * as `/run/cohost/credentials.json` in a RAM-only mount, written through a rename; a host-run program's arrives on the pipe
 * the unit runner passes as the descriptor `COHOST_CREDENTIALS_FD` names.
 */
import { createReadStream, readFileSync, unlinkSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { EARS_VERIFIER_PATH, secretPathMatches, unitSettings, type Logger } from "@cohost/config";

/** Where a container's message is written (a `tmpfs`, deployment DEPLOY-COMPOSE-033). */
export const CREDENTIALS_DIR = "/run/cohost";
/** The message's file name in `CREDENTIALS_DIR`. */
export const CREDENTIALS_FILE = "credentials.json";
/** The environment variable naming the descriptor a host-run program reads its message from. */
export const CREDENTIALS_FD_ENV = "COHOST_CREDENTIALS_FD";
/** The largest message accepted, bytes (STORE-DLV-002). */
export const MAX_CREDENTIALS_BYTES = 64 * 1024;

/** A received message: the store revision it was built from, the credentials by concrete secret path and the unit's state key. */
export interface ReceivedCredentials {
  revision: number;
  credentials: Readonly<Record<string, string>>;
  /** The 32-byte state key, for a unit whose manifest entry sets `stateKey` (STORE-STATE-001). */
  stateKey?: Buffer;
}

/** A replacement for `receiveCredentials`, for a test that runs a service with no delivery. */
export type CredentialsReceiver = (unit: string) => Promise<ReceivedCredentials>;

export interface ReceiveOptions {
  /** The environment to read `COHOST_CREDENTIALS_FD` from (default `process.env`). */
  env?: Readonly<Record<string, string | undefined>>;
  /** The directory to wait in (default `/run/cohost`). */
  dir?: string;
  /** Where a refused message is reported; never given a value. */
  log?: Pick<Logger, "warn">;
  /** How often the file is looked for besides directory events, ms (default 1000). */
  recheckMs?: number;
  /** Ends the wait: the promise rejects with the signal's reason. */
  signal?: AbortSignal;
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

/**
 * Checks a message's text for `unit`: at most 64 KiB of JSON `{format: 1, unit, revision, credentials, state_key?}`, the unit
 * its own, every credential a non-empty string at a path the unit declares (`ears.http.verifier` for `ears` excepted), and a
 * state key only for a unit that declares one, 32 bytes in base64url. A refusal's reason names paths, never a value.
 */
// @spec STORE-DLV-004
export function checkCredentialsMessage(unit: string, text: string): { ok: true; value: ReceivedCredentials } | { ok: false; reason: string } {
  const declared = unitSettings(unit);
  if (declared === undefined) return { ok: false, reason: `${unit} is not a unit of the manifest` };
  if (Buffer.byteLength(text, "utf8") > MAX_CREDENTIALS_BYTES) return { ok: false, reason: `the message is larger than ${MAX_CREDENTIALS_BYTES} bytes` };
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { ok: false, reason: "the message is not JSON" }; }
  if (!isObj(raw)) return { ok: false, reason: "the message is not a JSON object" };
  if (raw.format !== 1) return { ok: false, reason: "the message's format is not 1" };
  if (raw.unit !== unit) return { ok: false, reason: `the message is for ${typeof raw.unit === "string" ? raw.unit : "no unit"}, not ${unit}` };
  if (!Number.isInteger(raw.revision)) return { ok: false, reason: "the message has no revision" };
  if (!isObj(raw.credentials)) return { ok: false, reason: "the message has no credentials object" };
  const credentials: Record<string, string> = {};
  const undeclared: string[] = [];
  for (const [path, value] of Object.entries(raw.credentials)) {
    const allowed = path === EARS_VERIFIER_PATH ? unit === "ears" : declared.secrets.some((p) => secretPathMatches(path, p));
    if (!allowed) { undeclared.push(path); continue; }
    if (typeof value !== "string" || value === "") return { ok: false, reason: `the credential at ${path} is not a non-empty string` };
    credentials[path] = value;
  }
  if (undeclared.length > 0) return { ok: false, reason: `the message holds paths ${unit} does not declare: ${undeclared.join(", ")}` };
  let stateKey: Buffer | undefined;
  if (raw.state_key !== undefined) {
    if (!declared.stateKey) return { ok: false, reason: `the message holds a state key, which ${unit} does not declare` };
    stateKey = typeof raw.state_key === "string" && /^[A-Za-z0-9_-]+$/.test(raw.state_key) ? Buffer.from(raw.state_key, "base64url") : undefined;
    if (stateKey?.length !== 32) return { ok: false, reason: "the message's state key is not 32 bytes in base64url" };
  }
  return { ok: true, value: { revision: raw.revision as number, credentials, ...(stateKey ? { stateKey } : {}) } };
}

/** The descriptor's content to its end, refused past `MAX_CREDENTIALS_BYTES`. */
async function readDescriptor(fd: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of createReadStream("", { fd, autoClose: true }) as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_CREDENTIALS_BYTES) return " ".repeat(MAX_CREDENTIALS_BYTES + 1);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Receives `unit`'s credentials message. With `COHOST_CREDENTIALS_FD` set it reads that descriptor to its end; a refused
 * message there rejects, since nothing follows it on a closed pipe. Otherwise it waits for `/run/cohost/credentials.json`
 * (watching the directory and looking again at least once a second, with no timeout), reads it and deletes it; a refused
 * message is logged with the reason and waited past, so a corrected delivery can follow. Values are never logged.
 */
// @spec SHARED-BOOT-010, STORE-DLV-004
export async function receiveCredentials(unit: string, opts: ReceiveOptions = {}): Promise<ReceivedCredentials> {
  const env = opts.env ?? process.env;
  const fdText = env[CREDENTIALS_FD_ENV];
  if (fdText !== undefined && fdText !== "") {
    const fd = Number(fdText);
    if (!Number.isInteger(fd) || fd < 0) throw new Error(`${CREDENTIALS_FD_ENV} is not a file descriptor number`);
    const checked = checkCredentialsMessage(unit, await readDescriptor(fd));
    if (!checked.ok) throw new Error(`the credentials message on descriptor ${fd} was refused: ${checked.reason}`);
    return checked.value;
  }

  const dir = opts.dir ?? CREDENTIALS_DIR;
  const file = join(dir, CREDENTIALS_FILE);
  const recheckMs = opts.recheckMs ?? 1000;
  const { signal } = opts;
  let wake: (() => void) | undefined;
  let watcher: FSWatcher | undefined;
  try {
    watcher = watch(dir, () => wake?.());
    watcher.on("error", () => { watcher?.close(); watcher = undefined; });
  } catch {
    watcher = undefined; // no directory yet: the timed look still finds the file once it appears
  }
  try {
    for (;;) {
      signal?.throwIfAborted();
      let text: string | undefined;
      try {
        text = readFileSync(file, "utf8");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      if (text !== undefined) {
        try { unlinkSync(file); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
        const checked = checkCredentialsMessage(unit, text);
        if (checked.ok) return checked.value;
        opts.log?.warn({ file, reason: checked.reason }, `refused the credentials message: ${checked.reason}; waiting for another delivery`);
        continue;
      }
      await new Promise<void>((resolve, reject) => {
        const done = (): void => { clearTimeout(timer); signal?.removeEventListener("abort", aborted); wake = undefined; resolve(); };
        const aborted = (): void => { clearTimeout(timer); wake = undefined; reject(signal!.reason as Error); };
        const timer = setTimeout(done, recheckMs);
        wake = done;
        signal?.addEventListener("abort", aborted, { once: true });
      });
    }
  } finally {
    watcher?.close();
  }
}
