// Tool-calling contracts: the six tool events, the `tools` inject target, the `reminder` focus kind and `focus.source`
// (BUS-EVT-006, 010, 040, 043..051). BUS-EVT-040's cut enum is also exercised in clauses.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EVENT_TYPES, EventPayloads } from "../src/index.js";

const ok = (type: string, v: unknown): boolean => (EventPayloads as Record<string, { safeParse(v: unknown): { success: boolean } } | undefined>)[type]?.safeParse(v).success ?? false;
const without = (o: Record<string, unknown>, k: string): Record<string, unknown> => { const { [k]: _gone, ...rest } = o; return rest; };

const ORIGINS = ["speech", "guest", "chat", "vision", "reminder", "dashboard", "idle"];
const request = { id: "r1", tool: "get_time", arguments: {}, origin: "speech", round: 1, listed: true };
const result = { id: "r1", tool: "get_time", status: "ok", content: "noon", durationMs: 0 };
const catalogTool = { name: "get_time", description: "the time", parameters: { type: "object" }, label: "read", effect: "read", enabled: true, acts: false, chat: false, confirm: false, offered: true };
const catalog = { intervalMs: 5000, mode: "live", servers: [{ name: "builtin", state: "ok", external: false }], tools: [catalogTool] };

// @spec BUS-EVT-006
test("inject.request accepts the target tools", () => {
  const base = { id: "a", kind: "text", text: "x", remember: false };
  assert.equal(ok("inject.request", { ...base, target: "tools" }), true);
  assert.equal(ok("inject.request", { ...base, target: "voice" }), false);
});

// @spec BUS-EVT-010, BUS-EVT-051
test("attention.focus accepts kind reminder and an optional string focus.source, kept unchanged", () => {
  const schema = EventPayloads["attention.focus"];
  assert.equal(schema.safeParse({ reason: "reminder", score: 1, focus: { kind: "reminder", text: "stretch" } }).success, true);
  assert.equal(schema.safeParse({ reason: "r", score: 1, focus: { kind: "other", text: "x" } }).success, false);
  const withSource = schema.parse({ reason: "r", score: 1, focus: { kind: "speech", text: "x", source: "desktop" } });
  assert.equal((withSource.focus as { source?: string }).source, "desktop");
  const plain = schema.parse({ reason: "r", score: 1, focus: { kind: "speech", text: "x" } });
  assert.equal("source" in (plain.focus as object), false);
  assert.equal(schema.safeParse({ reason: "r", score: 1, focus: { kind: "speech", text: "x", source: 3 } }).success, false);
});

// @spec BUS-EVT-040
test("brain.clause accepts the cut tools only together with last", () => {
  const schema = EventPayloads["brain.clause"];
  assert.equal(schema.safeParse({ id: "1", seq: 2, text: "x", last: true, through: 1, cut: "tools" }).success, true);
  assert.equal(schema.safeParse({ id: "1", seq: 2, text: "x", cut: "tools" }).success, false);
});

// @spec BUS-EVT-043
test("the six tool events are in the catalog", () => {
  for (const t of ["tool.request", "tool.result", "tool.catalog", "tool.timer", "tool.confirm", "tool.answer"]) {
    assert.ok((EVENT_TYPES as readonly string[]).includes(t), t);
  }
});

// @spec BUS-EVT-043
test("tool.request requires its members, every origin, a name of [A-Za-z0-9_-]{1,64}, round from 1, and an optional injected boolean", () => {
  assert.equal(ok("tool.request", request), true);
  for (const origin of ORIGINS) assert.equal(ok("tool.request", { ...request, origin }), true, origin);
  assert.equal(ok("tool.request", { ...request, origin: "owner" }), false);
  assert.equal(ok("tool.request", { ...request, injected: true }), true);
  assert.equal(ok("tool.request", { ...request, injected: "yes" }), false);
  for (const tool of ["a".repeat(64), "A_b-9"]) assert.equal(ok("tool.request", { ...request, tool }), true, tool);
  for (const tool of ["", "a".repeat(65), "has space", "dot.name", "né"]) assert.equal(ok("tool.request", { ...request, tool }), false, tool);
  assert.equal(ok("tool.request", { ...request, round: 0 }), false);
  assert.equal(ok("tool.request", { ...request, round: 1.5 }), false);
  assert.equal(ok("tool.request", { ...request, round: 2 }), true);
  for (const k of ["id", "tool", "arguments", "origin", "round", "listed"]) assert.equal(ok("tool.request", without(request, k)), false, `missing ${k}`);
  assert.equal(ok("tool.request", { ...request, arguments: "x" }), false);
  assert.equal(ok("tool.request", { ...request, listed: "true" }), false);
});

// @spec BUS-EVT-044
test("tool.result requires its members, allows empty content, and takes truncated and mock only as true", () => {
  assert.equal(ok("tool.result", result), true);
  for (const status of ["ok", "error", "timeout", "refused"]) assert.equal(ok("tool.result", { ...result, status }), true, status);
  assert.equal(ok("tool.result", { ...result, status: "pending" }), false);
  assert.equal(ok("tool.result", { ...result, content: "" }), true);
  assert.equal(ok("tool.result", { ...result, durationMs: -1 }), false);
  assert.equal(ok("tool.result", { ...result, durationMs: 1.5 }), false);
  for (const k of ["truncated", "mock"]) {
    assert.equal(ok("tool.result", { ...result, [k]: true }), true, `${k} true`);
    assert.equal(ok("tool.result", { ...result, [k]: false }), false, `${k} false`);
  }
  for (const k of ["id", "tool", "status", "content", "durationMs"]) assert.equal(ok("tool.result", without(result, k)), false, `missing ${k}`);
});

// @spec BUS-EVT-045
test("tool.result reason: refusal reasons only with refused, tool_error/unavailable/limit only with error, none with ok or timeout", () => {
  const refusals = ["unknown_tool", "not_enabled", "acts_not_allowed", "not_approved", "definition_changed", "origin_not_allowed", "invalid_arguments", "server_down", "busy", "denied", "unconfirmed", "shutdown"];
  const errors = ["tool_error", "unavailable", "limit"];
  for (const reason of refusals) {
    assert.equal(ok("tool.result", { ...result, status: "refused", reason }), true, `refused/${reason}`);
    assert.equal(ok("tool.result", { ...result, status: "error", reason }), false, `error/${reason}`);
  }
  for (const reason of errors) {
    assert.equal(ok("tool.result", { ...result, status: "error", reason }), true, `error/${reason}`);
    assert.equal(ok("tool.result", { ...result, status: "refused", reason }), false, `refused/${reason}`);
  }
  for (const status of ["ok", "timeout"]) {
    assert.equal(ok("tool.result", { ...result, status, reason: "busy" }), false, `${status}/busy`);
    assert.equal(ok("tool.result", { ...result, status, reason: "tool_error" }), false, `${status}/tool_error`);
  }
  assert.equal(ok("tool.result", { ...result, status: "refused", reason: "bogus" }), false);
  assert.equal(ok("tool.result", { ...result, status: "refused" }), true, "reason stays optional");
});

// @spec BUS-EVT-046
test("tool.catalog requires intervalMs, mode, servers (name, state, external, optional detail) and tools", () => {
  assert.equal(ok("tool.catalog", catalog), true);
  assert.equal(ok("tool.catalog", { ...catalog, tools: [], servers: [] }), true);
  assert.equal(ok("tool.catalog", { ...catalog, intervalMs: 0 }), false);
  assert.equal(ok("tool.catalog", { ...catalog, intervalMs: 1.5 }), false);
  for (const mode of ["live", "mock"]) assert.equal(ok("tool.catalog", { ...catalog, mode }), true, mode);
  assert.equal(ok("tool.catalog", { ...catalog, mode: "dry" }), false);
  for (const state of ["ok", "down", "auth", "mock"]) assert.equal(ok("tool.catalog", { ...catalog, servers: [{ name: "s", state, external: true, detail: "d" }] }), true, state);
  assert.equal(ok("tool.catalog", { ...catalog, servers: [{ name: "s", state: "up", external: true }] }), false);
  assert.equal(ok("tool.catalog", { ...catalog, servers: [{ name: "s", state: "ok" }] }), false, "external is required");
  assert.equal(ok("tool.catalog", { ...catalog, servers: [{ name: "s", state: "ok", external: true, detail: 1 }] }), false);
  for (const k of ["intervalMs", "mode", "servers", "tools"]) assert.equal(ok("tool.catalog", without(catalog, k)), false, `missing ${k}`);
});

// @spec BUS-EVT-047
test("tool.catalog tool entries require name, description, parameters, label, effect and five booleans, and take optional server, title, hash and reason", () => {
  const withTool = (t: Record<string, unknown>) => ({ ...catalog, tools: [t] });
  assert.equal(ok("tool.catalog", withTool({ ...catalogTool, server: "s", title: "T", hash: "abc", reason: "changed" })), true);
  for (const label of ["read", "acts", "unlabelled"]) assert.equal(ok("tool.catalog", withTool({ ...catalogTool, label })), true, label);
  assert.equal(ok("tool.catalog", withTool({ ...catalogTool, label: "write" })), false);
  for (const effect of ["read", "acts"]) assert.equal(ok("tool.catalog", withTool({ ...catalogTool, effect })), true, effect);
  assert.equal(ok("tool.catalog", withTool({ ...catalogTool, effect: "unlabelled" })), false);
  for (const reason of ["not_enabled", "acts_not_allowed", "not_approved", "changed", "server_down"]) assert.equal(ok("tool.catalog", withTool({ ...catalogTool, reason })), true, reason);
  assert.equal(ok("tool.catalog", withTool({ ...catalogTool, reason: "definition_changed" })), false);
  assert.equal(ok("tool.catalog", withTool({ ...catalogTool, parameters: "x" })), false);
  for (const k of ["name", "description", "parameters", "label", "effect", "enabled", "acts", "chat", "confirm", "offered"]) assert.equal(ok("tool.catalog", withTool(without(catalogTool, k))), false, `missing ${k}`);
  for (const k of ["enabled", "acts", "chat", "confirm", "offered"]) assert.equal(ok("tool.catalog", withTool({ ...catalogTool, [k]: "yes" })), false, `${k} not boolean`);
  for (const k of ["server", "title", "hash"]) assert.equal(ok("tool.catalog", withTool({ ...catalogTool, [k]: 1 })), false, `${k} not string`);
});

// @spec BUS-EVT-048
test("tool.timer requires id, note, integer setAt and dueAt, and takes missed only as true", () => {
  const timer = { id: "t1", note: "stretch", setAt: 1, dueAt: 2 };
  assert.equal(ok("tool.timer", timer), true);
  assert.equal(ok("tool.timer", { ...timer, missed: true }), true);
  assert.equal(ok("tool.timer", { ...timer, missed: false }), false);
  assert.equal(ok("tool.timer", { ...timer, setAt: 1.5 }), false);
  assert.equal(ok("tool.timer", { ...timer, dueAt: "2" }), false);
  for (const k of ["id", "note", "setAt", "dueAt"]) assert.equal(ok("tool.timer", without(timer, k)), false, `missing ${k}`);
});

// @spec BUS-EVT-049
test("tool.confirm requires id, tool, arguments object, an origin as for tool.request, and integer expiresAt", () => {
  const confirm = { id: "r1", tool: "lights", arguments: { on: true }, origin: "chat", expiresAt: 5 };
  assert.equal(ok("tool.confirm", confirm), true);
  for (const origin of ORIGINS) assert.equal(ok("tool.confirm", { ...confirm, origin }), true, origin);
  assert.equal(ok("tool.confirm", { ...confirm, origin: "owner" }), false);
  assert.equal(ok("tool.confirm", { ...confirm, expiresAt: 1.5 }), false);
  assert.equal(ok("tool.confirm", { ...confirm, arguments: "x" }), false);
  for (const k of ["id", "tool", "arguments", "origin", "expiresAt"]) assert.equal(ok("tool.confirm", without(confirm, k)), false, `missing ${k}`);
});

// @spec BUS-EVT-050
test("tool.answer requires a string id and a boolean allow", () => {
  assert.equal(ok("tool.answer", { id: "r1", allow: true }), true);
  assert.equal(ok("tool.answer", { id: "r1", allow: false }), true);
  assert.equal(ok("tool.answer", { id: "r1" }), false);
  assert.equal(ok("tool.answer", { allow: true }), false);
  assert.equal(ok("tool.answer", { id: "r1", allow: "yes" }), false);
});
