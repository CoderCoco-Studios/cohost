import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigSchema, LoggingSchema, PRESENTATION, SECTION_PATHS, configLogger, createLogger, escapeTerminal, formatPretty, loadConfig, loggingSettings, parseYaml, setLoggingSource,
  redact, resetLoggingForTest, type TerminalOut,
} from "../src/index.js";
import { isolateEnv, repo, sandbox, captureWarnings, loadSettings } from "./helpers/config-sandbox.js";

isolateEnv();
afterEach(() => resetLoggingForTest());

/** A captured terminal: every text the sink writes, and whether it claims to be a TTY. */
function terminal(isTTY = false): TerminalOut & { text: () => string } {
  const chunks: string[] = [];
  return { write: (t: string) => { chunks.push(t); }, isTTY, text: () => chunks.join("") };
}

/** Writes the projection `settings.json` of a unit holding `sections` (each a parsed section) into `dir`. */
function writeProjection(dir: string, sections: Record<string, unknown>): void {
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ format: 1, unit: "svc", revision: 1, sections, documents: {} }));
}
/** The `logging` section of a YAML text written as the section's body. */
const loggingOf = (yaml: string): unknown => (parseYaml(`logging:\n${yaml}`) as { logging: unknown }).logging;

/**
 * A fresh config directory (whose projection holds the `logging` section given as YAML, when given), a fresh data directory,
 * and a captured terminal. The bootstrap read is forgotten so the next logger reads this directory.
 */
function setup(logging?: string, isTTY = false) {
  const dir = sandbox();
  if (logging !== undefined) writeProjection(dir, { logging: loggingOf(logging) });
  const data = mkdtempSync(join(tmpdir(), "cohost-data-"));
  process.env.COHOST_DATA_DIR = data;
  delete process.env.NO_COLOR;
  const out = terminal(isTTY);
  resetLoggingForTest(out);
  const logs = join(data, "logs");
  return { dir, data, logs, out, file: (svc: string) => join(logs, `${svc}.log`) };
}

const lines = (file: string): Record<string, unknown>[] =>
  readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);

const at = (h: number, m: number, s: number, ms: number) => new Date(2026, 10, 25, h, m, s, ms).getTime();
const entry = (o: Record<string, unknown>) => JSON.stringify({ level: 30, time: at(14, 3, 22, 517), pid: 1, hostname: "h", name: "chat", ...o });

// ---- schema, example file and presentation

// @spec CFG-SCH-113, CFG-SCH-114
test("the logging section is optional, blank level and terminal take their defaults, and a bad value fails naming its key", () => {
  const base = { cohost: { name: "a", streamer: "b" }, llm: { model: "m", embed_model: "e" }, vision: { model: "v", obs: {} }, chat: { twitch: {} }, voice: {}, avatar: { vtube_studio: {}, vmc: {} }, ears: {}, dashboard: {}, brain: {} };
  const defaults = { level: "info", terminal: "pretty", file: { enabled: true, max_size_mb: 10, max_files: 3 } };
  assert.deepEqual(ConfigSchema.parse(base).logging, defaults);
  assert.deepEqual(ConfigSchema.parse({ ...base, logging: { level: "", terminal: "" } }).logging, defaults);
  for (const level of ["fatal", "error", "warn", "info", "debug", "trace", "silent"]) assert.equal(LoggingSchema.parse({ level }).level, level);
  assert.equal(LoggingSchema.parse({ terminal: "json" }).terminal, "json");
  const failsAt = (logging: unknown, key: string) => {
    const r = ConfigSchema.safeParse({ ...base, logging });
    assert.ok(!r.success && r.error.issues.some((i) => i.path.join(".") === key), `${JSON.stringify(logging)} fails at ${key}`);
  };
  failsAt({ level: "verbose" }, "logging.level");
  failsAt({ terminal: "colour" }, "logging.terminal");
  failsAt({ file: { enabled: "yes" } }, "logging.file.enabled");
  for (const max_size_mb of [0, 1025, 1.5, "10"]) failsAt({ file: { max_size_mb } }, "logging.file.max_size_mb");
  for (const max_files of [0, 51, 2.5]) failsAt({ file: { max_files } }, "logging.file.max_files");
  assert.equal(LoggingSchema.parse({ file: { max_size_mb: 1024, max_files: 50 } }).file.max_files, 50);
});

// @spec CFG-USR-022
test("the shipped config.example.yaml writes the logging section as commented literals and loads with no warning", () => {
  const text = readFileSync(join(repo, "config", "config.example.yaml"), "utf8");
  const all = text.split("\n");
  const start = all.findIndex((l) => l.startsWith("logging:"));
  assert.ok(start >= 0, "logging section written");
  const end = all.findIndex((l, i) => i > start && /^\S/.test(l));
  const block = all.slice(start + 1, end < 0 ? undefined : end).filter((l) => /^\s+[a-z_]+:\s*\S/.test(l));
  assert.deepEqual(block.map((l) => l.replace(/\s*#.*$/, "").trim()), ["level: info", "terminal: pretty", "enabled: true", "max_size_mb: 10", "max_files: 3"]);
  for (const l of block) assert.match(l, /#/, `comment on: ${l.trim()}`);
  let cfg!: ReturnType<typeof loadSettings>;
  assert.deepEqual(captureWarnings(() => { cfg = loadSettings(text); }), []);
  assert.deepEqual(cfg.logging, { level: "info", terminal: "pretty", file: { enabled: true, max_size_mb: 10, max_files: 3 } });
});

// @spec CFG-PRES-021
test("the logging section is presented in System with help on each key, labelled options and the MB unit", () => {
  assert.ok(SECTION_PATHS.includes("logging"));
  const sec = PRESENTATION.sections.logging!;
  assert.equal(sec.title, "Logging");
  assert.equal(sec.group, "System");
  assert.match(sec.about, /next start/);
  for (const k of ["level", "terminal", "file.enabled", "file.max_size_mb", "file.max_files"]) assert.ok(PRESENTATION.keys[`logging.${k}`]?.help, k);
  const options = (k: string) => { const w = PRESENTATION.keys[k]!.widget; assert.equal(w?.type, "options"); return w?.type === "options" ? w.options : []; };
  assert.deepEqual(options("logging.level").map((o) => o.value), ["fatal", "error", "warn", "info", "debug", "trace", "silent"]);
  assert.deepEqual(options("logging.terminal").map((o) => o.value), ["pretty", "json"]);
  for (const o of [...options("logging.level"), ...options("logging.terminal")]) assert.ok(o.label.length > o.value.length, o.value);
  assert.equal(PRESENTATION.keys["logging.file.max_size_mb"]!.unit, "MB");
});

// ---- the bootstrap read

// @spec CFG-URL-004, CFG-LOG-002, CFG-LOG-004
test("createLogger is named for the service at logging.level, read once per process, and LOG_LEVEL has no effect", () => {
  const { dir } = setup("  level: debug\n");
  process.env.LOG_LEVEL = "error";
  const log = createLogger("svc-a");
  assert.equal(log.bindings().name, "svc-a");
  assert.equal(log.level, "debug");
  writeProjection(dir, { logging: { level: "warn" } });
  assert.equal(createLogger("svc-b").level, "debug", "the read is not repeated");
  assert.equal(configLogger().level, "debug");
});

// @spec CFG-URL-004, CFG-LOG-002, CFG-LOG-004
test("the bootstrap read loads .env first, so CONFIG_DIR there is honoured, and LOG_LEVEL in .env changes nothing", () => {
  const other = sandbox();
  writeProjection(other, { logging: { level: "trace" } });
  const { dir } = setup();
  delete process.env.CONFIG_DIR;
  writeFileSync(join(dir, "..", ".env"), `CONFIG_DIR=${other}\nLOG_LEVEL=error\n`);
  assert.equal(createLogger("svc").level, "trace");
  assert.equal(loggingSettings().level, "trace");
});

// @spec CFG-LOG-002
test("the bootstrap read takes a key written with no value as its default, as loadConfig does", () => {
  setup("  level:\n  terminal: json\n");
  assert.deepEqual(loggingSettings(), { level: "info", terminal: "json", file: { enabled: true, max_size_mb: 10, max_files: 3 } });
});

// @spec CFG-LOG-002
test("the bootstrap read validates the logging section alone, so an invalid other section does not reset it", () => {
  const { dir } = setup();
  writeProjection(dir, { cohost: { name: "", streamer: "Chris" }, logging: { level: "debug" } });
  assert.equal(createLogger("svc").level, "debug");
  assert.throws(() => loadConfig({ dir, force: true }), /cohost\.name/, "the projection is still invalid for loadConfig");
});

// @spec CFG-LOG-002, STORE-PKG-003
test("a registered logging source wins over the projection; with none registered the projection is read", () => {
  setup("  level: warn\n");
  setLoggingSource(() => ({ level: "trace", terminal: "json" }));
  assert.equal(createLogger("dashboard").level, "trace");
  assert.equal(loggingSettings().terminal, "json");
  resetLoggingForTest();
  assert.equal(loggingSettings().level, "warn", "resetting forgets the source: the projection in the config directory is read");
});

// @spec CFG-LOG-003
test("a missing settings.json, one that is not JSON or an invalid logging section gives the defaults and reports nothing", () => {
  const invalid = JSON.stringify({ format: 1, unit: "svc", revision: 1, sections: { logging: { level: "loud", file: { max_files: 99 } } }, documents: {} });
  for (const text of [undefined, "{not json", invalid]) {
    const { dir, out } = setup();
    if (text !== undefined) writeFileSync(join(dir, "settings.json"), text);
    const warnings = captureWarnings(() => { assert.equal(createLogger("svc").level, "info"); });
    assert.deepEqual(loggingSettings(), { level: "info", terminal: "pretty", file: { enabled: true, max_size_mb: 10, max_files: 3 } });
    assert.deepEqual(warnings, []);
    assert.equal(out.text(), "");
    assert.equal(existsSync(join(dir, "settings.json")), text !== undefined, "nothing is written");
  }
});

// ---- the terminal

// @spec CFG-LOG-005, CFG-LOG-006
test("pretty prints local time, padded level, name and message, and each further message line four spaces in", () => {
  assert.equal(formatPretty(entry({ msg: "joined" }), false), "14:03:22.517 INFO  chat: joined\n");
  const invalid = entry({ level: 50, name: "dashboard", msg: "Invalid config.yaml:\n  llm.model: too short\n  dashboard.lan_port: must differ\n\n(overrides applied: x)" });
  assert.equal(formatPretty(invalid, false), [
    "14:03:22.517 ERROR dashboard: Invalid config.yaml:",
    "      llm.model: too short",
    "      dashboard.lan_port: must differ",
    "",
    "    (overrides applied: x)",
    "",
  ].join("\n"));
  for (const [n, name] of [[10, "TRACE"], [20, "DEBUG"], [40, "WARN "], [60, "FATAL"]] as const) {
    assert.equal(formatPretty(entry({ level: n, msg: "m" }), false), `14:03:22.517 ${name} chat: m\n`);
  }
});

// @spec CFG-LOG-007
test("pretty writes scalar fields as key=value in field order, quoting only an ambiguous string", () => {
  const line = formatPretty(entry({ msg: "joined channel", channel: "cocostream", attempt: 2, ok: true, none: null, empty: "", spaced: "a b", eq: "a=b", q: 'say "hi"' }), false);
  assert.equal(line, '14:03:22.517 INFO  chat: joined channel channel=cocostream attempt=2 ok=true none=null empty="" spaced="a b" eq="a=b" q="say \\"hi\\""\n');
});

// @spec CFG-LOG-008
test("pretty writes objects and arrays as indented JSON, and an error as its stack and leftover properties", () => {
  const obj = formatPretty(entry({ msg: "m", deps: { redis: "up" }, list: [1, 2] }), false);
  assert.equal(obj, ["14:03:22.517 INFO  chat: m", "    deps:", "      {", '        "redis": "up"', "      }", "    list:", "      [", "        1,", "        2", "      ]", ""].join("\n"));
  const err = formatPretty(entry({ level: 40, name: "cortex", msg: "model call failed", err: { type: "Error", message: "connect ECONNREFUSED", stack: "Error: connect ECONNREFUSED\n    at TCPConnectWrap.afterConnect (node:net:1611:16)", code: "ECONNREFUSED" } }), false);
  assert.equal(err, [
    "14:03:22.517 WARN  cortex: model call failed",
    "    err:",
    "      Error: connect ECONNREFUSED",
    "          at TCPConnectWrap.afterConnect (node:net:1611:16)",
    '      {"code":"ECONNREFUSED"}',
    "",
  ].join("\n"));
  assert.doesNotMatch(formatPretty(entry({ msg: "m", err: { type: "Error", message: "x", stack: "Error: x" } }), false), /\{/);
});

// @spec CFG-LOG-009
test("the level name is coloured only on a TTY with NO_COLOR unset or empty", () => {
  const colours: [number, string][] = [[60, "31"], [50, "31"], [40, "33"], [30, "32"], [20, "34"], [10, "90"]];
  for (const [level, code] of colours) assert.match(formatPretty(entry({ level, msg: "m" }), true), new RegExp(`^14:03:22\\.517 \\u001b\\[${code}m[A-Z]+\\u001b\\[39m`));
  const write = (isTTY: boolean, noColor?: string): string => {
    const { out } = setup(undefined, isTTY);
    if (noColor !== undefined) process.env.NO_COLOR = noColor;
    createLogger("svc").warn("careful");
    return out.text();
  };
  assert.match(write(true), /\u001b\[33mWARN\u001b\[39m  svc: careful/);
  assert.match(write(true, ""), /\u001b\[33m/);
  assert.doesNotMatch(write(true, "1"), /\u001b/);
  assert.doesNotMatch(write(false), /\u001b/);
});

// @spec CFG-LOG-010
test("pretty escapes control characters, DEL and bidirectional controls in messages, keys and values, keeping the tab", () => {
  const nasty = "a\u001b[2Jb\rc\u007fd\u0085e‮f⁦g\th";
  const out = formatPretty(entry({ msg: `${nasty}\nnext\u001b]0;x\u0007`, [`k\u001b`]: nasty, obj: { v: "\u009b31m‪" } }), false);
  assert.doesNotMatch(out, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/);
  assert.match(out, /chat: a\\u001b\[2Jb\\u000dc\\u007fd\\u0085e\\u202ef\\u2066g\th/);
  assert.match(out, /\n    next\\u001b\]0;x\\u0007/);
  assert.match(out, / k\\u001b=/);
  assert.match(out, /\\u009b31m\\u202a/);
  assert.equal(escapeTerminal("⁩‬"), "\\u2069\\u202c");
});

// @spec CFG-LOG-011, CFG-LOG-012
test("json prints pino's own line, and the file holds that same line whatever the terminal format", () => {
  const { out, file } = setup("  terminal: json\n");
  createLogger("chat").info({ channel: "c" }, "hello");
  assert.equal(out.text(), readFileSync(file("chat"), "utf8"));
  const [e] = lines(file("chat"));
  assert.equal(e!.msg, "hello");
  assert.equal(e!.channel, "c");
  assert.equal(e!.level, 30);
  assert.equal(typeof e!.time, "number");
  assert.equal(e!.pid, process.pid);
  assert.equal(typeof e!.hostname, "string");
});

// ---- the file

// @spec CFG-LOG-012, CFG-LOG-013
test("each entry at or above the level is in data/logs/<service>.log as pino's JSON line before the call returns, dir 0755 and file 0644", () => {
  const { out, logs, file } = setup("  level: info\n");
  const log = createLogger("dashboard");
  log.debug("hidden");
  log.info({ port: 3000 }, "listening");
  assert.deepEqual(lines(file("dashboard")).map((e) => [e.msg, e.port]), [["listening", 3000]]);
  assert.match(out.text(), /INFO  dashboard: listening port=3000\n$/);
  assert.equal(statSync(logs).mode & 0o777, 0o755);
  assert.equal(statSync(file("dashboard")).mode & 0o777, 0o644);
  log.error("last words");
  assert.equal(lines(file("dashboard")).at(-1)!.msg, "last words", "written synchronously");
});

// @spec CFG-LOG-014
test("a log file deleted or replaced by hand is reopened at the next entry", () => {
  const { file } = setup();
  const log = createLogger("chat");
  log.info("one");
  rmSync(file("chat"));
  log.info("two");
  assert.deepEqual(lines(file("chat")).map((e) => e.msg), ["two"]);
  renameSync(file("chat"), `${file("chat")}.old`);
  writeFileSync(file("chat"), "");
  log.info("three");
  assert.deepEqual(lines(file("chat")).map((e) => e.msg), ["three"]);
  assert.deepEqual(lines(`${file("chat")}.old`).map((e) => e.msg), ["two"]);
});

// @spec CFG-LOG-015, CFG-LOG-016
test("a file that would pass max_size_mb rotates through numbered files, and those past max_files are deleted", () => {
  const { logs, file } = setup("  file: { max_size_mb: 1, max_files: 2 }\n");
  const log = createLogger("chat");
  const big = "x".repeat(600 * 1024);
  for (let i = 1; i <= 5; i++) log.info({ i, big }, `entry ${i}`);
  assert.deepEqual(readdirSync(logs).toSorted(), ["chat.1.log", "chat.2.log", "chat.log"]);
  assert.deepEqual(lines(file("chat")).map((e) => e.i), [5]);
  assert.deepEqual(lines(join(logs, "chat.1.log")).map((e) => e.i), [4]);
  assert.deepEqual(lines(join(logs, "chat.2.log")).map((e) => e.i), [3]);
  // a file numbered past max_files from a larger earlier setting is deleted at the next rotation
  writeFileSync(join(logs, "chat.7.log"), "old\n");
  log.info({ big }, "six");
  assert.deepEqual(readdirSync(logs).toSorted(), ["chat.1.log", "chat.2.log", "chat.log"]);
});

// @spec CFG-LOG-015, CFG-LOG-021
test("a retried rotation after a failed .log rename does not shift the older files a second time", () => {
  const { logs, file } = setup("  file: { max_size_mb: 1, max_files: 3 }\n");
  const log = createLogger("chat");
  log.info({ big: "a".repeat(700 * 1024) }, "current");
  // the state a failed attempt leaves: the older files already moved up one, `.1.log` free, `.log` still in place
  writeFileSync(join(logs, "chat.2.log"), "older\n");
  log.info({ big: "b".repeat(700 * 1024) }, "next");
  assert.deepEqual(readdirSync(logs).toSorted(), ["chat.1.log", "chat.2.log", "chat.log"]);
  assert.equal(readFileSync(join(logs, "chat.2.log"), "utf8"), "older\n", "chat.2.log stayed where it was");
  assert.deepEqual(lines(join(logs, "chat.1.log")).map((e) => e.msg), ["current"]);
  assert.deepEqual(lines(file("chat")).map((e) => e.msg), ["next"]);
});

// @spec CFG-LOG-015
test("an empty file is never rotated, so an entry larger than the limit is written whole", () => {
  const { logs, file } = setup("  file: { max_size_mb: 1, max_files: 3 }\n");
  createLogger("chat").info({ huge: "y".repeat(2 * 1024 * 1024) }, "huge");
  assert.deepEqual(readdirSync(logs), ["chat.log"]);
  assert.equal((lines(file("chat"))[0]!.huge as string).length, 2 * 1024 * 1024);
});

// @spec CFG-LOG-017
test("later createLogger calls share the first call's sink and file and keep their own names", () => {
  const { logs, file } = setup();
  createLogger("memory").info("from the program");
  createLogger("pg").info("from a library");
  assert.deepEqual(readdirSync(logs), ["memory.log"]);
  assert.deepEqual(lines(file("memory")).map((e) => [e.name, e.msg]), [["memory", "from the program"], ["pg", "from a library"]]);
});

// @spec CFG-LOG-018, CFG-LOG-019
test("a config-logger warning before any program logger reaches the terminal only, and one after lands in the program's file", () => {
  const { data, out, file } = setup();
  configLogger().warn("before");
  assert.match(out.text(), /WARN  config: before/);
  assert.equal(existsSync(join(data, "logs")), false, "no file is opened");
  createLogger("dashboard");
  configLogger().warn("after");
  assert.deepEqual(lines(file("dashboard")).map((e) => [e.name, e.msg]), [["config", "after"]]);
  assert.deepEqual(readdirSync(join(data, "logs")), ["dashboard.log"], "the first warning is in no file");
});

// @spec CFG-LOG-018
test("the loader's own diagnostics go through the config logger to the program's sink", () => {
  const { dir, file } = setup();
  writeProjection(dir, { logging: {}, bogus_key: 1 });
  createLogger("chat");
  loadConfig({ dir, force: true });
  assert.ok(lines(file("chat")).some((e) => e.name === "config" && /ignoring unknown keys: bogus_key/.test(String(e.msg))));
});

// @spec CFG-LOG-020
test("a log directory that cannot be created warns once per failure episode while the terminal keeps every entry", () => {
  const { data, out } = setup();
  writeFileSync(join(data, "logs"), "a file where the directory belongs");
  const log = createLogger("chat");
  assert.doesNotThrow(() => { log.info("one"); log.info("two"); });
  const warnings = () => out.text().split("\n").filter((l) => /cannot write the log file/.test(l));
  assert.equal(warnings().length, 1);
  assert.match(warnings()[0]!, /WARN  chat: cannot write the log file .*chat\.log: (EEXIST|ENOTDIR)/);
  assert.match(out.text(), /chat: one\n[\s\S]*chat: two\n/);
  rmSync(join(data, "logs"));
  log.info("three");
  assert.deepEqual(lines(join(data, "logs", "chat.log")).map((e) => e.msg), ["three"]);
  rmSync(join(data, "logs"), { recursive: true });
  writeFileSync(join(data, "logs"), "broken again");
  log.info("four");
  assert.equal(warnings().length, 2, "a new episode warns again");
});

// @spec CFG-LOG-021
test("a rotation that cannot rename warns once, keeps appending to the current file and retries at the next entry", { skip: process.getuid?.() === 0 ? "root ignores directory permissions" : false }, () => {
  const { logs, out, file } = setup("  file: { max_size_mb: 1, max_files: 3 }\n");
  const log = createLogger("chat");
  const big = "z".repeat(700 * 1024);
  log.info({ big }, "first");
  chmodSync(logs, 0o555);
  try {
    log.info({ big }, "second");
    log.info({ big }, "third");
  } finally { chmodSync(logs, 0o755); }
  const warnings = () => out.text().split("\n").filter((l) => /cannot rotate the log file/.test(l));
  assert.equal(warnings().length, 1);
  assert.match(warnings()[0]!, /EACCES/);
  assert.deepEqual(lines(file("chat")).map((e) => e.msg), ["first", "second", "third"]);
  log.info({ big }, "fourth");
  assert.deepEqual(readdirSync(logs).toSorted(), ["chat.1.log", "chat.log"]);
  assert.deepEqual(lines(file("chat")).map((e) => e.msg), ["fourth"]);
});

// @spec CFG-LOG-022
test("a sink created with { file: false } writes no file whatever logging.file.enabled holds, and file.enabled false writes none either", () => {
  const a = setup("  file: { enabled: true }\n");
  createLogger("tools", { file: false }).info("x");
  createLogger("other").info("y");
  assert.equal(existsSync(a.logs), false);
  assert.match(a.out.text(), /tools: x\n.*other: y\n/);
  const b = setup("  file: { enabled: false }\n");
  createLogger("chat").info("x");
  assert.equal(existsSync(b.logs), false);
});

// @spec CFG-LOG-023
test("the sink's uncaughtExceptionMonitor listener logs fatal with err in both outputs", () => {
  const { out, file } = setup();
  const before = process.listenerCount("uncaughtExceptionMonitor");
  createLogger("chat");
  assert.equal(process.listenerCount("uncaughtExceptionMonitor"), before + 1);
  createLogger("again");
  assert.equal(process.listenerCount("uncaughtExceptionMonitor"), before + 1, "one listener per sink");
  process.emit("uncaughtExceptionMonitor", new Error("boom"), "uncaughtException");
  process.emit("uncaughtExceptionMonitor", new Error("nope"), "unhandledRejection");
  const [crash, rejection] = lines(file("chat"));
  assert.equal(crash!.level, 60);
  assert.equal(crash!.msg, "uncaught exception");
  assert.match((crash!.err as { stack: string }).stack, /Error: boom/);
  assert.equal(rejection!.msg, "unhandled rejection");
  assert.match(out.text(), /FATAL chat: uncaught exception\n    err:\n      Error: boom/);
});

// @spec CFG-LOG-023
test("a crashing program logs the error to its file and still exits with Node's status 1, for a throw and an unhandled rejection", () => {
  const index = join(repo, "packages", "config", "dist", "index.js");
  for (const [crash, msg] of [["setTimeout(() => { throw new Error('kaboom'); }, 0)", "uncaught exception"], ["Promise.reject(new Error('kaboom'))", "unhandled rejection"]] as const) {
    const { dir } = setup();
    const data = process.env.COHOST_DATA_DIR!;
    const code = `import { createLogger } from ${JSON.stringify(index)}; createLogger("crashy").info("up"); ${crash};`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      encoding: "utf8", env: { PATH: process.env.PATH, CONFIG_DIR: dir, COHOST_DATA_DIR: data, COHOST_ENV_FILE: join(dir, "none.env") },
    });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /kaboom/, "Node's own report still prints");
    const last = lines(join(data, "logs", "crashy.log")).at(-1)!;
    assert.equal(last.level, 60);
    assert.equal(last.msg, msg);
    assert.match((last.err as { message: string }).message, /kaboom/);
    assert.match(r.stdout, new RegExp(`FATAL crashy: ${msg}`));
  }
});

// @spec CFG-LOG-024
test("token, authorization, password, api_key, apikey, secret and cookie are censored at any depth in both outputs, without touching the caller's objects", () => {
  const { out, file } = setup();
  const cfg = { llm: { openai: { api_key: "sk-live", base_url: "https://x" } } };
  const log = createLogger("chat").child({ Cookie: "c=1" });
  log.info({ token: "t0k", req: { headers: { Authorization: "Bearer abc", accept: "json" } }, apiKey: "k", list: [{ PASSWORD: "p" }, { secret: "s" }], cfg, keep: "visible" }, "request");
  const [e] = lines(file("chat"));
  assert.equal(e!.token, "[Redacted]");
  assert.deepEqual(e!.req, { headers: { Authorization: "[Redacted]", accept: "json" } });
  assert.equal(e!.apiKey, "[Redacted]");
  assert.deepEqual(e!.list, [{ PASSWORD: "[Redacted]" }, { secret: "[Redacted]" }]);
  assert.deepEqual(e!.cfg, { llm: { openai: { api_key: "[Redacted]", base_url: "https://x" } } });
  assert.equal(e!.Cookie, "[Redacted]");
  assert.equal(e!.keep, "visible");
  for (const secret of ["sk-live", "t0k", "Bearer abc", "c=1", '"k"']) {
    assert.ok(!readFileSync(file("chat"), "utf8").includes(secret), `file holds ${secret}`);
    assert.ok(!out.text().includes(secret), `terminal holds ${secret}`);
  }
  assert.equal(cfg.llm.openai.api_key, "sk-live", "the caller's object is unchanged");
  const err = Object.assign(new Error("failed"), { token: "inner" });
  log.error({ err }, "with an error");
  const logged = lines(file("chat")).at(-1)!.err as Record<string, unknown>;
  assert.equal(logged.token, "[Redacted]");
  assert.match(String(logged.stack), /Error: failed/);
  assert.equal(err.token, "inner");
});

// @spec CFG-LOG-024
test("a credential reached twice through a shared reference, or through a cycle, is censored everywhere", () => {
  const { out, file } = setup();
  const log = createLogger("chat");
  const creds = { token: "SHARED-LEAK", user: "u" };
  log.info({ a: creds, b: creds, list: [creds] }, "shared");
  const cyc: Record<string, unknown> = { token: "CYCLE-LEAK", n: 1 };
  cyc.self = cyc;
  log.info({ cyc }, "cycle");
  const text = readFileSync(file("chat"), "utf8");
  for (const leak of ["SHARED-LEAK", "CYCLE-LEAK"]) {
    assert.ok(!text.includes(leak), `file holds ${leak}`);
    assert.ok(!out.text().includes(leak), `terminal holds ${leak}`);
  }
  const [shared, cycle] = lines(file("chat"));
  assert.deepEqual(shared!.a, { token: "[Redacted]", user: "u" });
  assert.deepEqual(shared!.b, { token: "[Redacted]", user: "u" });
  assert.deepEqual(shared!.list, [{ token: "[Redacted]", user: "u" }]);
  assert.deepEqual(cycle!.cyc, { token: "[Redacted]", n: 1, self: "[Circular]" });
  assert.equal(creds.token, "SHARED-LEAK", "the caller's objects are unchanged");
  assert.equal(cyc.token, "CYCLE-LEAK");
});

// @spec CFG-LOG-024
test("a class instance is walked through its own keys and keeps its prototype; a Buffer, a typed array and a Date pass through", () => {
  class Client { constructor(public apiKey: string, public host: string) {} describe(): string { return `client@${this.host}`; } }
  const client = new Client("CLASS-LEAK", "h");
  const r = redact({ client }) as { client: Client };
  assert.ok(r.client instanceof Client, "the prototype is kept");
  assert.equal(r.client.apiKey, "[Redacted]");
  assert.equal(r.client.describe(), "client@h");
  assert.equal(client.apiKey, "CLASS-LEAK", "the original is unchanged");
  const buf = Buffer.from("x");
  const arr = new Uint8Array([1]);
  const date = new Date(0);
  const passed = redact({ buf, arr, date }) as Record<string, unknown>;
  assert.equal(passed.buf, buf);
  assert.equal(passed.arr, arr);
  assert.equal(passed.date, date);
  const { file } = setup();
  createLogger("chat").info({ client }, "instance");
  assert.ok(!readFileSync(file("chat"), "utf8").includes("CLASS-LEAK"));
});

// @spec CFG-LOG-024
test("a class instance whose toJSON throws on the censored copy is written as its own enumerable fields", () => {
  class Session {
    readonly #id: string;
    constructor(id: string, public token: string, public host: string) { this.#id = id; }
    toJSON(): object { return { id: this.#id, host: this.host }; }
  }
  const session = new Session("s1", "PRIVATE-LEAK", "h");
  const r = redact({ session }) as { session: Session };
  assert.ok(r.session instanceof Session, "the prototype is kept");
  assert.deepEqual(JSON.parse(JSON.stringify(r.session)), { token: "[Redacted]", host: "h" });
  assert.deepEqual(JSON.parse(JSON.stringify(session)), { id: "s1", host: "h" }, "the original's toJSON is untouched");
  const { file } = setup();
  createLogger("chat").info({ session }, "private field");
  const [e] = lines(file("chat"));
  assert.deepEqual(e!.session, { token: "[Redacted]", host: "h" });
  assert.ok(!readFileSync(file("chat"), "utf8").includes("PRIVATE-LEAK"));
});

// @spec CFG-LOG-025
test("logging adds no dependency, uses no pino transport and starts no worker thread", () => {
  const pkg = JSON.parse(readFileSync(join(repo, "packages", "config", "package.json"), "utf8")) as { dependencies: Record<string, string> };
  assert.deepEqual(Object.keys(pkg.dependencies).toSorted(), ["pino", "yaml", "zod"]);
  const src = join(repo, "packages", "config", "src");
  for (const f of readdirSync(src)) {
    const text = readFileSync(join(src, f), "utf8");
    assert.doesNotMatch(text, /pino\.transport|\btransport\s*:\s*\{|worker_threads|thread-stream|pino-pretty|pino-roll/, f);
  }
});
