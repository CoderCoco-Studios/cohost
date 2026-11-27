import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { ConfigSchema, type Config } from "../src/index.js";
import { MINIMAL_YAML, isolateEnv, loadSettings, exampleYaml, captureWarnings, repo } from "./helpers/config-sandbox.js";

isolateEnv();

const base = () => ({
  cohost: { name: "a", streamer: "b" }, llm: { model: "m", embed_model: "e" }, vision: { model: "v", obs: {} }, chat: { twitch: {} },
  voice: {}, avatar: { vtube_studio: { host: "h" }, vmc: { host: "h" } }, ears: {}, dashboard: {}, brain: {},
});
const parse = (tools?: unknown, brain: Record<string, unknown> = {}) =>
  ConfigSchema.safeParse({ ...base(), brain, ...(tools === undefined ? {} : { tools }) });
const ok = (tools?: unknown): any => { const r = parse(tools); assert.ok(r.success, JSON.stringify(r.error?.issues)); return (r.data as any).tools; };
const failPaths = (tools: unknown): string[] => { const r = parse(tools); return r.success ? [] : r.error.issues.map((i) => i.path.join(".")); };
const failsAt = (tools: unknown, path: string): boolean => failPaths(tools).some((p) => p === path || p.startsWith(`${path}.`));
/** Every message of a failed parse, to check that a URL value or userinfo is never quoted. */
const messages = (tools: unknown): string => { const r = parse(tools); return r.success ? "" : r.error.issues.map((i) => i.message).join("\n"); };

const FILLERS = ["Let me check.", "Hold on, let me look.", "One sec, checking.", "Hang on, looking that up.", "Give me a moment.", "Let me see."];

// @spec CFG-SCH-075, CFG-SCH-076, CFG-SCH-077, CFG-SCH-078, CFG-SCH-079, CFG-SCH-080, CFG-SCH-081, CFG-SCH-092, CFG-SCH-093, CFG-SCH-094, CFG-SCH-095
test("an absent tools section, or any absent key, takes every default, and no tool is enabled", () => {
  const defaults = {
    mode: "live", timeout_ms: 10000, confirm_timeout_ms: 20000, max_result_chars: 1500, max_concurrent: 4, catalog_ms: 30000,
    max_tools_per_server: 32, max_tools: 64, owner_sources: "all", servers: {}, allow: {},
    timer: { max_active: 5, max_minutes: 120 }, stream_info: { cache_ms: 30000 },
    reply: { max_rounds: 3, max_calls: 3, budget_ms: 30000, filler_after_ms: 1500, max_tokens: 512, filler_lines: FILLERS },
  };
  assert.deepEqual(ok(), defaults);
  assert.deepEqual(ok({}), defaults);
  assert.deepEqual(ok({ timer: {}, stream_info: {}, reply: {} }), defaults);
  assert.deepEqual(Object.keys(ok().allow), []);
  assert.equal(ok({ timeout_ms: 5 }).timeout_ms, 5);
});

// @spec CFG-SCH-076
test("tools.mode takes live or mock, blank means live, anything else fails naming tools.mode", () => {
  assert.equal(ok({ mode: "" }).mode, "live");
  assert.equal(ok({ mode: "mock" }).mode, "mock");
  assert.equal(ok({ mode: "live" }).mode, "live");
  assert.ok(failsAt({ mode: "stub" }, "tools.mode"));
});

// @spec CFG-SCH-077
test("tools.timeout_ms and tools.confirm_timeout_ms are positive integers", () => {
  for (const k of ["timeout_ms", "confirm_timeout_ms"]) {
    for (const bad of [0, -1, 1.5, "x", null]) assert.ok(failsAt({ [k]: bad }, `tools.${k}`), `${k}=${String(bad)}`);
    assert.equal(ok({ [k]: 1 })[k], 1);
  }
});

// @spec CFG-SCH-078, CFG-SCH-079, CFG-SCH-080, CFG-SCH-081
test("the integer floors: max_result_chars 64, max_concurrent 1, catalog_ms 5000, max_tools_per_server 1, max_tools 1", () => {
  const floors: [string, number][] = [["max_result_chars", 64], ["max_concurrent", 1], ["catalog_ms", 5000], ["max_tools_per_server", 1], ["max_tools", 1]];
  for (const [k, min] of floors) {
    assert.ok(failsAt({ [k]: min - 1 }, `tools.${k}`), `${k} below its floor`);
    assert.ok(failsAt({ [k]: min + 0.5 }, `tools.${k}`), `${k} non-integer`);
    assert.equal(ok({ [k]: min })[k], min);
  }
});

// @spec CFG-SCH-082
test("tools.owner_sources is the word all or a list of ears.sources names; another word or a bad entry fails naming it", () => {
  assert.equal(ok({ owner_sources: "all" }).owner_sources, "all");
  assert.deepEqual(ok({ owner_sources: ["discord", "desktop", "http", "dir"] }).owner_sources, ["discord", "desktop", "http", "dir"]);
  assert.deepEqual(ok({ owner_sources: [] }).owner_sources, []);
  assert.ok(failsAt({ owner_sources: "everyone" }, "tools.owner_sources"));
  assert.ok(failsAt({ owner_sources: ["discord", "Bad Name"] }, "tools.owner_sources.1"));
  assert.ok(failsAt({ owner_sources: [""] }, "tools.owner_sources.0"));
});

// @spec CFG-SCH-083
test("a tools.servers key must match [a-z][a-z0-9-]{0,31}, else the load fails naming tools.servers.<name>", () => {
  const url = { url: "http://h:1/mcp" };
  for (const good of ["a", "weather", "web-search", "s2", "a".repeat(32)]) assert.deepEqual(Object.keys(ok({ servers: { [good]: url } }).servers), [good]);
  for (const bad of ["Weather", "2fast", "under_score", "-x", "a".repeat(33), "has space"]) assert.ok(failsAt({ servers: { [bad]: url } }, `tools.servers.${bad}`), bad);
});

// @spec CFG-SCH-084
test("a tools.servers url must be http or https; a missing or other one fails naming tools.servers.<name>.url and never quotes the value", () => {
  assert.equal(ok({ servers: { a: { url: "http://host.docker.internal:8931/mcp" } } }).servers.a.url, "http://host.docker.internal:8931/mcp");
  assert.equal(ok({ servers: { a: { url: "https://search.example.com/mcp" } } }).servers.a.url, "https://search.example.com/mcp");
  for (const bad of ["ftp://secret-host-77/mcp", "stdio:secret-host-77", "secret-host-77", "", "file:///secret-host-77"]) {
    assert.ok(failsAt({ servers: { a: { url: bad } } }, "tools.servers.a.url"), bad);
    assert.doesNotMatch(messages({ servers: { a: { url: bad } } }), /secret-host-77/, `quotes ${bad}`);
  }
  assert.ok(failsAt({ servers: { a: {} } }, "tools.servers.a.url"));
});

// @spec CFG-SCH-085
test("a tools.servers url with userinfo fails naming tools.servers.<name>.url and never quoting the userinfo", () => {
  for (const bad of ["http://alice:hunter2@h/mcp", "https://hunter2@h/mcp", "http://:hunter2@h/mcp"]) {
    assert.ok(failsAt({ servers: { a: { url: bad } } }, "tools.servers.a.url"), bad);
    assert.doesNotMatch(messages({ servers: { a: { url: bad } } }), /hunter2|alice/, `quotes userinfo of ${bad}`);
  }
});

// @spec CFG-SCH-086
test("a credential-like query parameter loads with one warning naming the server and parameter, never the value", () => {
  const names = ["key", "token", "api_key", "apikey", "secret", "auth", "password", "access_token"];
  for (const n of names) {
    let cfg!: Config;
    const warnings = captureWarnings(() => { cfg = loadSettings(`${MINIMAL_YAML}tools:\n  servers:\n    search:\n      url: "http://h:1/mcp?${n}=s3cr3t-value&x=1"\n`); });
    const mine = warnings.filter((w) => /search/.test(w) && w.includes(n));
    assert.equal(mine.length, 1, `${n}: ${JSON.stringify(warnings)}`);
    assert.doesNotMatch(warnings.join("\n"), /s3cr3t-value/);
    assert.ok(cfg.tools.servers.search);
  }
});

// @spec CFG-SCH-086
test("a query with no credential-like parameter warns about nothing, and a server with one warns once", () => {
  const warnings = captureWarnings(() => { loadSettings(`${MINIMAL_YAML}tools:\n  servers:\n    plain:\n      url: "http://h:1/mcp?region=eu&limit=5"\n    keyed:\n      url: "http://h:1/mcp?apikey=zzz"\n`); });
  assert.equal(warnings.filter((w) => /plain/.test(w)).length, 0);
  assert.equal(warnings.filter((w) => /keyed/.test(w) && /apikey/.test(w)).length, 1);
  assert.doesNotMatch(warnings.join("\n"), /zzz/);
});

// @spec CFG-SCH-087, CFG-SCH-088
test("a server entry defines header (a valid header name, blank meaning Authorization), token (default empty) and an optional external boolean", () => {
  const s = ok({ servers: { a: { url: "http://h/mcp" } } }).servers.a;
  assert.equal(s.token, "");
  assert.ok(s.header === "" || s.header === undefined || s.header === "Authorization");
  assert.ok(s.external === undefined || s.external === false);
  const full = ok({ servers: { a: { url: "http://h/mcp", header: "X-Api-Key", external: true } } }).servers.a;
  assert.equal(full.header, "X-Api-Key");
  assert.equal(full.external, true);
  assert.equal(ok({ servers: { a: { url: "http://h/mcp", external: false } } }).servers.a.external, false);
  for (const bad of ["bad header", "x:y", "x\ny", "é"]) assert.ok(failsAt({ servers: { a: { url: "http://h/mcp", header: bad } } }, "tools.servers.a.header"), bad);
  assert.ok(failsAt({ servers: { a: { url: "http://h/mcp", external: "yes" } } }, "tools.servers.a.external"));
});

// @spec CFG-SCH-089
test("a tools.allow key must match [A-Za-z0-9_-]{1,64}, else the load fails naming tools.allow.<name>", () => {
  for (const good of ["a", "get_time", "weather__forecast", "Web-Search", "x".repeat(64)]) assert.deepEqual(Object.keys(ok({ allow: { [good]: {} } }).allow), [good]);
  for (const bad of ["has space", "dot.name", "x".repeat(65), "a/b"]) assert.ok(failsAt({ allow: { [bad]: {} } }, `tools.allow.${bad}`), bad);
});

// @spec CFG-SCH-090
test("a tools.allow entry defaults enabled, acts, chat false, confirm true, hash empty, effect read; effect is read, acts or unlabelled", () => {
  assert.deepEqual(ok({ allow: { t: {} } }).allow.t, { enabled: false, acts: false, chat: false, confirm: true, hash: "", effect: "read" });
  for (const e of ["read", "acts", "unlabelled"]) assert.equal(ok({ allow: { t: { effect: e } } }).allow.t.effect, e);
  assert.ok(failsAt({ allow: { t: { effect: "write" } } }, "tools.allow.t.effect"));
  for (const k of ["enabled", "acts", "chat", "confirm"]) assert.ok(failsAt({ allow: { t: { [k]: "yes" } } }, `tools.allow.t.${k}`), k);
  assert.ok(failsAt({ allow: { t: { hash: 5 } } }, "tools.allow.t.hash"));
});

// @spec CFG-SCH-091
test("a tools.allow entry with acts and chat both true fails naming tools.allow.<name>; either alone loads", () => {
  assert.ok(failsAt({ allow: { danger: { acts: true, chat: true } } }, "tools.allow.danger"));
  assert.equal(ok({ allow: { t: { acts: true } } }).allow.t.acts, true);
  assert.equal(ok({ allow: { t: { chat: true } } }).allow.t.chat, true);
});

// @spec CFG-SCH-092, CFG-SCH-093
test("tools.timer.max_active and max_minutes are at least 1; tools.stream_info.cache_ms is a non-negative integer", () => {
  for (const k of ["max_active", "max_minutes"]) {
    assert.ok(failsAt({ timer: { [k]: 0 } }, `tools.timer.${k}`));
    assert.ok(failsAt({ timer: { [k]: 1.5 } }, `tools.timer.${k}`));
    assert.equal(ok({ timer: { [k]: 1 } }).timer[k], 1);
  }
  assert.equal(ok({ stream_info: { cache_ms: 0 } }).stream_info.cache_ms, 0);
  assert.ok(failsAt({ stream_info: { cache_ms: -1 } }, "tools.stream_info.cache_ms"));
  assert.ok(failsAt({ stream_info: { cache_ms: 0.5 } }, "tools.stream_info.cache_ms"));
});

// @spec CFG-SCH-094
test("tools.reply integers: max_rounds, max_calls, budget_ms, max_tokens at least 1; filler_after_ms at least 0", () => {
  for (const k of ["max_rounds", "max_calls", "budget_ms", "max_tokens"]) {
    assert.ok(failsAt({ reply: { [k]: 0 } }, `tools.reply.${k}`), k);
    assert.equal(ok({ reply: { [k]: 1 } }).reply[k], 1);
  }
  assert.equal(ok({ reply: { filler_after_ms: 0 } }).reply.filler_after_ms, 0);
  assert.ok(failsAt({ reply: { filler_after_ms: -1 } }, "tools.reply.filler_after_ms"));
  assert.ok(failsAt({ reply: { filler_after_ms: 1.5 } }, "tools.reply.filler_after_ms"));
});

// @spec CFG-SCH-095
test("tools.reply.filler_lines is a list of non-empty strings of at most 200 characters; empty is allowed", () => {
  assert.deepEqual(ok({ reply: { filler_lines: [] } }).reply.filler_lines, []);
  assert.deepEqual(ok({ reply: { filler_lines: ["Hm.", "x".repeat(200)] } }).reply.filler_lines, ["Hm.", "x".repeat(200)]);
  assert.ok(failsAt({ reply: { filler_lines: ["ok", ""] } }, "tools.reply.filler_lines.1"));
  assert.ok(failsAt({ reply: { filler_lines: ["x".repeat(201)] } }, "tools.reply.filler_lines.0"));
  assert.ok(failsAt({ reply: { filler_lines: [5] } }, "tools.reply.filler_lines.0"));
});

// @spec CFG-SCH-096
test("brain.salience.reminder_expiry_ms is a positive integer defaulting to 1800000", () => {
  const r = (v?: unknown) => parse(undefined, { salience: v === undefined ? {} : { reminder_expiry_ms: v } });
  const get = (res: any) => res.data.brain.salience.reminder_expiry_ms;
  assert.equal(get(r()), 1800000);
  assert.equal(get(r(60000)), 60000);
  for (const bad of [0, -1, 1.5, "soon"]) {
    const res = r(bad);
    assert.ok(!res.success && res.error.issues.some((i) => i.path.join(".") === "brain.salience.reminder_expiry_ms"), String(bad));
  }
});

// @spec CFG-USR-020, CFG-SCH-075
test("the shipped config.example.yaml writes the tools section as literals and loads with no warning", () => {
  const text = readFileSync(join(repo, "config", "config.example.yaml"), "utf8");
  const raw = parseYaml(text) as { tools?: Record<string, unknown> & { reply?: Record<string, unknown> } };
  assert.ok(raw.tools, "tools section written");
  assert.equal(raw.tools.mode, "live");
  assert.deepEqual(raw.tools.servers, {});
  assert.deepEqual(raw.tools.allow, {});
  assert.equal(raw.tools.owner_sources, "all");
  assert.deepEqual(raw.tools.reply?.filler_lines, FILLERS);
  for (const [k, v] of Object.entries({ max_rounds: 3, max_calls: 3, budget_ms: 30000, filler_after_ms: 1500, max_tokens: 512 })) assert.equal(raw.tools.reply?.[k], v, k);
  // a comment on each literal line of the section
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith("tools:"));
  const end = lines.findIndex((l, i) => i > start && /^\S/.test(l) && !l.startsWith("#"));
  const block = lines.slice(start + 1, end < 0 ? undefined : end).filter((l) => /^\s+[a-z_]+:\s*\S/.test(l) && !/^\s+-/.test(l));
  assert.ok(block.length >= 8);
  for (const l of block) assert.match(l, /#/, `comment on: ${l.trim()}`);
  let cfg!: Config;
  const warnings = captureWarnings(() => { cfg = loadSettings(exampleYaml()); });
  assert.deepEqual(warnings, []);
  assert.equal(cfg.tools.mode, "live");
  assert.deepEqual(cfg.tools.servers, {});
  assert.deepEqual(cfg.tools.reply.filler_lines, FILLERS);
});
