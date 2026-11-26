/**
 * Every cohost program's logger (config design, "Logging"). The first `createLogger(service)` of a process reads the `logging`
 * section (the bootstrap read) and builds the process's one sink: standard output, in the `pretty` or `json` form, and the file
 * `<dataDir()>/logs/<service>.log`, both written synchronously in this thread. No pino transport and no worker thread.
 */
import { readFileSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { isatty } from "node:tty";
import { join } from "node:path";
import { parseDocument } from "yaml";
import pino from "pino";
import { LoggingSchema, type LoggingSettings } from "./schema.js";
import { configDir, dataDir, loadDotEnv } from "./paths.js";
import { formatPretty } from "./log-pretty.js";
import { LogFile } from "./log-file.js";

export type Logger = pino.Logger;

export interface CreateLoggerOptions {
  /** `false` builds a sink that writes no file, whatever `logging.file.enabled` holds (CFG-LOG-022). Only the call that creates the sink decides. */
  file?: boolean;
}

/** Where the terminal form is written; standard output unless a test swaps it. */
export interface TerminalOut {
  write(text: string): void;
  readonly isTTY: boolean;
}

/** Writes all of `text` to standard output before returning, waiting out a full non-blocking pipe. */
function writeStdoutSync(text: string): void {
  const buf = Buffer.from(text, "utf8");
  let off = 0;
  let waits = 0;
  while (off < buf.length) {
    try {
      off += writeSync(1, buf, off, buf.length - off);
    } catch (err) {
      if ((err as { code?: string }).code !== "EAGAIN" || ++waits > 1000) return;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
    }
  }
}

const STDOUT: TerminalOut = { write: writeStdoutSync, get isTTY() { return isatty(1); } };

/** The field names whose values are censored, compared lower-cased (CFG-LOG-024). */
const REDACTED_KEYS = new Set(["token", "authorization", "password", "api_key", "apikey", "secret", "cookie"]);
const CENSOR = "[Redacted]";

/**
 * `value` with every field named in `REDACTED_KEYS`, at any depth of its plain objects, arrays and errors, replaced by
 * `[Redacted]`. Copies only what changes, so the caller's objects are never modified; anything else passes through.
 */
// @spec CFG-LOG-024
export function redact(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((v: unknown) => { const r = redact(v, seen); if (r !== v) changed = true; return r; });
    return changed ? out : value;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  const isError = value instanceof Error;
  if (!isError && proto !== Object.prototype && proto !== null) return value;
  const src = value as Record<string, unknown>;
  let copy: Record<string, unknown> | undefined;
  for (const key of Object.keys(src)) {
    const cur = src[key];
    const next = REDACTED_KEYS.has(key.toLowerCase()) ? CENSOR : redact(cur, seen);
    if (next === cur) continue;
    copy ??= isError ? copyError(value) : { ...src };
    copy[key] = next;
  }
  return copy ?? value;
}

/** A copy of an error with its prototype, own properties, and `message` and `stack` read out as plain values (V8 keeps the stack behind an accessor bound to the original). */
function copyError(err: Error): Record<string, unknown> {
  const copy = Object.create(Object.getPrototypeOf(err) as object, Object.getOwnPropertyDescriptors(err)) as Record<string, unknown>;
  for (const key of ["message", "stack"] as const) Object.defineProperty(copy, key, { value: err[key], writable: true, configurable: true, enumerable: false });
  return copy;
}

const formatters = {
  log: (obj: Record<string, unknown>) => redact(obj) as Record<string, unknown>,
  bindings: (b: pino.Bindings) => redact(b) as pino.Bindings,
};

interface Sink {
  service: string;
  write: (line: string) => void;
  file: LogFile | undefined;
  crash: (err: unknown, origin: string) => void;
}

let out: TerminalOut = STDOUT;
let settings: LoggingSettings | undefined;
let sink: Sink | undefined;
let configLog: Logger | undefined;

/**
 * The process's one read of the `logging` section: `.env` first (it never overrides a set variable), then `config.yaml` in the
 * config directory, that section alone. A missing or unparsable file, or an invalid section, gives the defaults silently:
 * `loadConfig` reports the same fault moments later.
 */
// @spec CFG-LOG-002, CFG-LOG-003, CFG-LOG-004
export function loggingSettings(): LoggingSettings {
  if (settings) return settings;
  let section: unknown;
  try {
    loadDotEnv();
    const doc = parseDocument(readFileSync(join(configDir(), "config.yaml"), "utf8"));
    if (doc.errors.length === 0) section = (doc.toJS() as { logging?: unknown } | null)?.logging;
  } catch { /* missing or unreadable: the defaults */ }
  const parsed = LoggingSchema.safeParse(section ?? {});
  settings = parsed.success ? parsed.data : LoggingSchema.parse({});
  return settings;
}

/** The terminal text of one serialised entry under the read settings: pino's line for `json`, the laid-out lines for `pretty`. */
function terminalWrite(line: string): void {
  try {
    if (loggingSettings().terminal === "json") out.write(line);
    else out.write(formatPretty(line, out.isTTY && !process.env.NO_COLOR));
  } catch { /* logging never throws */ }
}

/** One warning about the log file itself, to the terminal only, in the terminal's form. */
function terminalWarning(name: string, msg: string): void {
  terminalWrite(`${JSON.stringify({ level: 40, time: Date.now(), pid: process.pid, hostname: hostname(), name, msg })}\n`);
}

/**
 * A pino logger on `write` whose own fields and every child's bindings are censored: pino applies `formatters.bindings` to the
 * root's bindings only, so `child` censors its bindings itself. Children inherit the method through pino's prototype chain.
 */
type ChildFn = (this: Logger, bindings: pino.Bindings, options?: pino.ChildLoggerOptions) => Logger;

function makeLogger(name: string, level: string, write: (line: string) => void): Logger {
  const log = pino({ name, level, formatters }, destination(write));
  const child = (Object.getPrototypeOf(log) as { child: ChildFn }).child;
  const censored = function (this: Logger, bindings: pino.Bindings, options?: pino.ChildLoggerOptions): Logger {
    return child.call(this, redact(bindings) as pino.Bindings, options);
  };
  Object.defineProperty(log, "child", { value: censored, writable: true, configurable: true });
  return log;
}

const destination = (write: (line: string) => void): pino.DestinationStream => ({ write });

// @spec CFG-LOG-017, CFG-LOG-022, CFG-LOG-023
function createSink(service: string, withFile: boolean): Sink {
  const s = loggingSettings();
  const file = withFile && s.file.enabled
    ? new LogFile({
        dir: join(dataDir(), "logs"), service,
        maxBytes: s.file.max_size_mb * 1024 * 1024, maxFiles: s.file.max_files,
        warn: (msg) => terminalWarning(service, msg),
      })
    : undefined;
  const write = (line: string): void => {
    terminalWrite(line);
    file?.write(line);
  };
  const crashLog = makeLogger(service, s.level, write);
  // Logs the crash synchronously and leaves Node's default handling (print, exit status 1) to run.
  const crash = (err: unknown, origin: string): void => {
    try { crashLog.fatal({ err }, origin === "unhandledRejection" ? "unhandled rejection" : "uncaught exception"); } catch { /* logging never throws */ }
  };
  process.on("uncaughtExceptionMonitor", crash);
  return { service, write, file, crash };
}

/**
 * A pino logger named for `service` at `logging.level`. The process's first call builds the sink and names its file for
 * `service`; later calls share that sink and keep their own name.
 */
// @spec CFG-URL-004, CFG-LOG-017, CFG-LOG-022, CFG-LOG-025
export function createLogger(service: string, options: CreateLoggerOptions = {}): Logger {
  const s = loggingSettings();
  sink ??= createSink(service, options.file !== false);
  return makeLogger(service, s.level, sink.write);
}

/**
 * The loader's own logger, named `config`. It never builds or names the sink: each write goes to the sink that exists at that
 * moment, or, before there is one, to the terminal alone.
 */
// @spec CFG-LOG-001, CFG-LOG-018
export function configLogger(): Logger {
  configLog ??= makeLogger("config", loggingSettings().level, (line) => {
    if (sink) sink.write(line);
    else terminalWrite(line);
  });
  return configLog;
}

/**
 * Forget the process's bootstrap read and sink (closing its file and removing its crash listener), and write the terminal form
 * to `terminal` (standard output when omitted). For tests only: a program keeps one sink for its life.
 */
export function resetLoggingForTest(terminal?: TerminalOut): void {
  if (sink) {
    process.off("uncaughtExceptionMonitor", sink.crash);
    sink.file?.close();
  }
  sink = undefined;
  settings = undefined;
  configLog = undefined;
  out = terminal ?? STDOUT;
}
