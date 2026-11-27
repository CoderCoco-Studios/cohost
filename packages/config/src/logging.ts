/**
 * Every cohost program's logger (config design, "Logging"). The first `createLogger(service)` of a process reads the `logging`
 * section (the bootstrap read) and builds the process's one sink: standard output, in the `pretty` or `json` form, and the file
 * `<dataDir()>/logs/<service>.log`, both written synchronously in this thread. No pino transport and no worker thread.
 */
import { readFileSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { isatty } from "node:tty";
import { join } from "node:path";
import pino from "pino";
import { LoggingSchema, type LoggingSettings } from "./schema.js";
import { configDir, dataDir, loadDotEnv } from "./paths.js";
import { coerceEmptyNumbers } from "./pipeline.js";
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
      if ((err as { code?: string }).code !== "EAGAIN" || ++waits > 1000) {
        // Giving up part-way through a line: end it, so the next entry starts on a line of its own.
        if (off > 0) try { writeSync(1, "\n"); } catch { /* stdout is gone or still full */ }
        return;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
    }
  }
}

const STDOUT: TerminalOut = { write: writeStdoutSync, get isTTY() { return isatty(1); } };

/** The field names whose values are censored, compared lower-cased (CFG-LOG-024). */
const REDACTED_KEYS = new Set(["token", "authorization", "password", "api_key", "apikey", "secret", "cookie"]);
const CENSOR = "[Redacted]";

/**
 * `value` with every field named in `REDACTED_KEYS`, at any depth of its objects, arrays and errors, replaced by
 * `[Redacted]`. A class instance is walked through its own enumerable keys and copied with its prototype; a Buffer, a typed
 * array or a Date passes through. Copies only what changes, so the caller's objects are never modified. `memo` maps each
 * object already met to its result, so a shared reference is censored everywhere it appears and a cycle ends in
 * `[Circular]` instead of the uncensored original.
 */
// @spec CFG-LOG-024
export function redact(value: unknown, memo: Map<object, unknown> = new Map()): unknown {
  if (value === null || typeof value !== "object") return value;
  if (memo.has(value)) return memo.get(value);
  if (ArrayBuffer.isView(value) || value instanceof Date) { memo.set(value, value); return value; }
  memo.set(value, "[Circular]");
  let result: unknown = value;
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((v: unknown) => { const r = redact(v, memo); if (r !== v) changed = true; return r; });
    if (changed) result = out;
  } else {
    const src = value as Record<string, unknown>;
    let copy: Record<string, unknown> | undefined;
    for (const key of Object.keys(src)) {
      const cur = src[key];
      const next = REDACTED_KEYS.has(key.toLowerCase()) ? CENSOR : redact(cur, memo);
      if (next === cur) continue;
      copy ??= copyObject(value);
      copy[key] = next;
    }
    if (copy) result = copy;
  }
  memo.set(value, result);
  return result;
}

/**
 * A copy of an object with its prototype and own properties. An error's `message` and `stack` are read out as plain values
 * (V8 keeps the stack behind an accessor bound to the original). A `toJSON` the copy inherits or owns is replaced by an
 * own, non-enumerable wrapper that calls it on the copy and, when it throws (the copy is not a real instance, so a
 * `toJSON` that reads a `#private` field fails on it), falls back to the copy's own enumerable fields.
 */
function copyObject(obj: object): Record<string, unknown> {
  const proto = Object.getPrototypeOf(obj) as object | null;
  if (proto === Object.prototype) return { ...(obj as Record<string, unknown>) };
  const copy = Object.create(proto, Object.getOwnPropertyDescriptors(obj)) as Record<string, unknown>;
  if (obj instanceof Error) {
    for (const key of ["message", "stack"] as const) Object.defineProperty(copy, key, { value: obj[key], writable: true, configurable: true, enumerable: false });
  }
  const toJSON: unknown = copy.toJSON;
  if (typeof toJSON === "function") {
    // The copy is not a real instance: a `toJSON` that reads a `#private` field throws on it, so it serialises as its own
    // enumerable fields instead.
    Object.defineProperty(copy, "toJSON", {
      value(this: Record<string, unknown>, key: string): unknown {
        try { return (toJSON as (this: unknown, key: string) => unknown).call(this, key); } catch { return { ...this }; }
      },
      writable: true, configurable: true, enumerable: false,
    });
  }
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
let colour: boolean | undefined;
let source: LoggingSource | undefined;

/** Where a store-owning program's `logging` section comes from: a function returning the stored section (or undefined). */
export type LoggingSource = () => unknown;

/**
 * Registers the `logging` section's source for this process (CFG-LOG-002): the dashboard, `cohostctl`, the unit runner and the
 * `config:*` tasks register the settings store's stored section before their first log line (settings-store STORE-PKG-003).
 * A process that registers none reads the section from its projection.
 */
// @spec CFG-LOG-002
export function setLoggingSource(fn: LoggingSource | undefined): void { source = fn; }

/**
 * The process's one read of the `logging` section: `.env` first (it never overrides a set variable), then the section from the
 * registered logging source (`setLoggingSource`), else from the projection's `settings.json` in the config directory, that
 * section alone. A missing or unparsable file, or an invalid section, gives the defaults silently: `loadConfig` or the store
 * reports the same fault.
 */
// @spec CFG-LOG-002, CFG-LOG-003, CFG-LOG-004
export function loggingSettings(): LoggingSettings {
  if (settings) return settings;
  let section: unknown;
  try {
    loadDotEnv();
    if (source) section = source();
    else {
      const raw = JSON.parse(readFileSync(join(configDir(), "settings.json"), "utf8")) as { sections?: Record<string, unknown> } | null;
      section = raw?.sections?.logging;
    }
  } catch { /* missing or unreadable: the defaults */ }
  // A key written with no value is null and takes its default, as in loadConfig (CFG-LOAD-002).
  const parsed = LoggingSchema.safeParse(coerceEmptyNumbers(section ?? {}));
  settings = parsed.success ? parsed.data : LoggingSchema.parse({});
  return settings;
}

/**
 * Whether the level name is coloured (CFG-LOG-009): standard output is a TTY and `NO_COLOR` is unset or empty. Decided once,
 * when the sink is created (or at the first terminal-only write before there is one), not per entry.
 */
function colourOn(): boolean {
  colour ??= out.isTTY && !process.env.NO_COLOR;
  return colour;
}

/** The terminal text of one serialised entry under the read settings: pino's line for `json`, the laid-out lines for `pretty`. */
function terminalWrite(line: string): void {
  try {
    if (loggingSettings().terminal === "json") out.write(line);
    else out.write(formatPretty(line, colourOn()));
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
  colour = undefined;
  colourOn();
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
  colour = undefined;
  source = undefined;
  out = terminal ?? STDOUT;
}
