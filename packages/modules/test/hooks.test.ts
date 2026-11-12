/**
 * Hook runner behaviour that needs a controlled provider or clock: timeouts and aborts, cool-off after repeated
 * failures, provider health, warning text, and the request a `http` hook sends.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { ModuleSchema, type ModuleConfig as ConfigModuleConfig } from "@cohost/config";
import type { ChatMessage, ChatOptions, ChatProvider } from "@cohost/llm";
import {
  HOOK_COOLOFF_AFTER, HOOK_COOLOFF_MS, Module, hookHealth, type ModuleConfig, type ModuleImpl,
} from "../src/index.js";

const llmCfg = { provider: "ollama", model: "x", embed_model: "x" } as never;
type In = { n: number };
type Out = { out: number };
const rules = (i: In): Out => ({ out: i.n * 2 });
const validate = (raw: unknown): Out | undefined => {
  const o = (raw as { out?: unknown })?.out;
  return typeof o === "number" ? { out: o } : undefined;
};
const llmImpl: ModuleImpl<In, Out> = { rules, llm: { system: "s", user: (i) => `n=${i.n}`, validate }, http: { validate } };

interface Logged { obj: Record<string, unknown>; msg: string }
function recorder(): { log: never; warns: Logged[] } {
  const warns: Logged[] = [];
  const log = { info() {}, error() {}, debug() {}, warn: (obj: Record<string, unknown>, msg: string) => warns.push({ obj, msg }) } as never;
  return { log, warns };
}

/** A chat provider whose behaviour each test scripts. */
class FakeProvider implements ChatProvider {
  name = "fake";
  model = "fake-model";
  lastError?: string;
  pingIsNominal?: boolean;
  calls: { messages: ChatMessage[]; opts?: ChatOptions }[] = [];
  pingResult = true;
  constructor(private behave: (opts: ChatOptions | undefined) => Promise<string> = async () => '{"out": 1}') {}
  async chat(messages: ChatMessage[], opts?: ChatOptions): Promise<string> {
    this.calls.push({ messages, opts });
    return this.behave(opts);
  }
  async ping(): Promise<boolean> { this.lastError = this.pingResult ? undefined : "unreachable"; return this.pingResult; }
}

const llmModule = (provider: ChatProvider, over: Record<string, unknown> = {}, opts: Record<string, unknown> = {}, log = recorder().log) =>
  new Module("t", ModuleSchema.parse({ kind: "llm", ...over }), llmCfg, llmImpl, log, { provider, ...opts });

// @spec HOOK-CFG-001
test("ModuleConfig is the one type from @cohost/config", () => {
  const same: ConfigModuleConfig = ModuleSchema.parse({});
  const viaModules: ModuleConfig = same;
  assert.equal(viaModules.kind, "rules");
});

// @spec HOOK-CFG-002
test("a hook's timeout_ms defaults to 8000, long enough for a hosted model that thinks", () => {
  assert.equal(ModuleSchema.parse({}).timeout_ms, 8000);
});

// @spec HOOK-LLM-003
test("llm kind: maxTokens defaults to 200 when the hook names none", async () => {
  const p = new FakeProvider();
  await llmModule(p).run({ n: 1 });
  assert.equal(p.calls[0]!.opts?.maxTokens, 200);
  assert.equal(p.calls[0]!.opts?.json, true);
  assert.equal(p.calls[0]!.opts?.temperature, 0);
});

// @spec HOOK-LLM-004, HOOK-LLM-006
test("llm kind: a provider that ignores the signal still settles at the timeout, and the signal it was given is aborted", async () => {
  let seen: AbortSignal | undefined;
  const p = new FakeProvider((opts) => { seen = opts?.signal; return new Promise<string>(() => { /* never settles */ }); });
  const t0 = performance.now();
  assert.deepEqual(await llmModule(p, { timeout_ms: 120 }).run({ n: 3 }), { out: 6 });
  assert.ok(performance.now() - t0 < 1000, "settled near the timeout");
  assert.equal(seen?.aborted, true, "the losing request is told to stop");
});

// @spec HOOK-LLM-005, HOOK-FALLBACK-003
test("llm kind: a reply whose JSON root is an array reaches validate, and is rejected when the shape is wrong", async () => {
  const seenRaw: unknown[] = [];
  const impl: ModuleImpl<In, Out> = { rules, llm: { system: "s", user: () => "u", validate: (raw) => { seenRaw.push(raw); return undefined; } } };
  const p = new FakeProvider(async () => 'Scores: [0.2, 0.9] done');
  const m = new Module("t", ModuleSchema.parse({ kind: "llm" }), llmCfg, impl, recorder().log, { provider: p });
  assert.deepEqual(await m.run({ n: 2 }), { out: 4 });
  assert.deepEqual(seenRaw, [[0.2, 0.9]]);
});

// @spec HOOK-FALLBACK-004
test("a validate that throws falls back to rules instead of rejecting", async () => {
  const impl: ModuleImpl<In, Out> = { rules, llm: { system: "s", user: () => "u", validate: () => { throw new Error("bad validator"); } } };
  const { log, warns } = recorder();
  const m = new Module("t", ModuleSchema.parse({ kind: "llm" }), llmCfg, impl, log, { provider: new FakeProvider() });
  assert.deepEqual(await m.run({ n: 5 }), { out: 10 });
  assert.match(warns[0]!.msg, /bad validator/);
});

// @spec HOOK-WARN-001, HOOK-WARN-003
test("the fallback warning is limited per 30 s on a monotonic clock and carries the suppressed count", async () => {
  let now = 1_000_000;
  const { log, warns } = recorder();
  const p = new FakeProvider(async () => "no json at all");
  const m = llmModule(p, {}, { now: () => now, coolOffAfter: 1000 }, log);
  for (let n = 0; n < 3; n++) await m.run({ n });
  assert.equal(warns.length, 1);
  now += 29_999;
  await m.run({ n: 9 });
  assert.equal(warns.length, 1);
  now += 1;
  await m.run({ n: 9 });
  assert.equal(warns.length, 2);
  assert.deepEqual(warns[1]!.obj, { module: "t", kind: "llm", suppressed: 3 });
});

// @spec HOOK-WARN-002
test("the fallback warning says what failed: the error text cut at 120 characters, or that the answer was unusable", async () => {
  const { log, warns } = recorder();
  const failing = llmModule(new FakeProvider(async () => { throw new Error("x".repeat(300)); }), {}, {}, log);
  await failing.run({ n: 1 });
  assert.match(warns[0]!.msg, /^module failed \(Error: x+\); using rules$/);
  assert.equal(warns[0]!.msg.length, "module failed (".length + 120 + "); using rules".length);
  const unusable = llmModule(new FakeProvider(async () => '{"nope":1}'), {}, {}, log);
  await unusable.run({ n: 1 });
  assert.equal(warns[1]!.msg, "module returned something unusable; using rules");
});

// ---- http

const seen: { method?: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
let reply: { status: number; body: string } = { status: 200, body: '{"out": 7}' };
const server = http.createServer(async (req, res) => {
  let body = ""; for await (const c of req) body += c;
  seen.push({ method: req.method, headers: req.headers, body });
  res.statusCode = reply.status;
  res.setHeader("content-type", "application/json");
  res.end(reply.body);
});
await new Promise<void>((r) => server.listen(0, r));
after(() => server.close());
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/m`;
const httpModule = (over: Record<string, unknown> = {}, opts: Record<string, unknown> = {}, log = recorder().log) =>
  new Module("t", ModuleSchema.parse({ kind: "http", url, timeout_ms: 30_000, ...over }), llmCfg, llmImpl, log, opts);

// @spec HOOK-HTTP-001, HOOK-HTTP-002
test("http kind: POSTs the input as JSON with a json content type", async () => {
  reply = { status: 200, body: '{"out": 7}' };
  assert.deepEqual(await httpModule().run({ n: 4 }), { out: 7 });
  const req = seen.at(-1)!;
  assert.equal(req.method, "POST");
  assert.equal(req.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(req.body), { n: 4 });
});

// @spec HOOK-FALLBACK-002
test("http kind: a 2xx answer that is not JSON falls back to rules", async () => {
  reply = { status: 200, body: "<html>oops</html>" };
  assert.deepEqual(await httpModule().run({ n: 4 }), { out: 8 });
});

// ---- cool-off

// @spec HOOK-COOL-001
test("a hook that fails N times in a row is skipped for the cool-off period, then tried again", async () => {
  let now = 5_000;
  const { log, warns } = recorder();
  const p = new FakeProvider(async () => { throw new Error("down"); });
  const m = llmModule(p, {}, { now: () => now }, log);
  assert.equal(HOOK_COOLOFF_AFTER, 5);
  for (let n = 0; n < HOOK_COOLOFF_AFTER; n++) await m.run({ n });
  assert.equal(p.calls.length, HOOK_COOLOFF_AFTER);
  assert.equal(m.coolingOff, true);
  assert.deepEqual(await m.run({ n: 7 }), { out: 14 }, "rules answer while cooling off");
  assert.equal(p.calls.length, HOOK_COOLOFF_AFTER, "no call, so no billing, while cooling off");
  assert.ok(warns.some((w) => /cooling off/.test(w.msg)), "entering cool-off is logged");
  now += HOOK_COOLOFF_MS - 1;
  await m.run({ n: 1 });
  assert.equal(p.calls.length, HOOK_COOLOFF_AFTER);
  now += 1;
  assert.equal(m.coolingOff, false);
  await m.run({ n: 1 });
  assert.equal(p.calls.length, HOOK_COOLOFF_AFTER + 1, "one trial call after the period");
  assert.equal(m.coolingOff, true, "a failed trial starts another cool-off at once");
});

// @spec HOOK-COOL-002
test("a success resets the failure streak, and unusable answers count as failures", async () => {
  const replies = ['{"nope":1}', '{"nope":1}', '{"nope":1}', '{"nope":1}', '{"out": 3}', '{"nope":1}', '{"nope":1}', '{"nope":1}', '{"nope":1}'];
  const p = new FakeProvider(async () => replies.shift()!);
  const m = llmModule(p);
  for (let n = 0; n < 9; n++) await m.run({ n });
  assert.equal(m.coolingOff, false, "four failures, a success, four failures: never five in a row");
  assert.equal(p.calls.length, 9);
});

// @spec HOOK-COOL-003
test("a rules hook never cools off and never calls out", async () => {
  const m = new Module("t", ModuleSchema.parse({ kind: "rules" }), llmCfg, llmImpl, recorder().log);
  for (let n = 0; n < 10; n++) await m.run({ n });
  assert.equal(m.coolingOff, false);
});

// ---- health

// @spec HOOK-HEALTH-001
test("ping asks the hook's provider and records the answer; a rules hook has nothing to ping", async () => {
  const p = new FakeProvider();
  const m = llmModule(p);
  assert.equal(m.health().reachable, undefined, "not yet checked");
  assert.equal(await m.ping(), true);
  assert.equal(m.health().reachable, true);
  p.pingResult = false;
  assert.equal(await m.ping(), false);
  assert.equal(m.health().reachable, false);
  assert.equal(m.health().detail, "unreachable");
  const rulesHook = new Module("r", ModuleSchema.parse({ kind: "rules" }), llmCfg, llmImpl, recorder().log);
  assert.equal(await rulesHook.ping(), undefined);
});

// @spec HOOK-HEALTH-002
test("a nominal ping (bedrock) is not counted as reachable", async () => {
  const p = new FakeProvider();
  p.pingIsNominal = true;
  const m = llmModule(p);
  assert.equal(await m.ping(), true);
  assert.equal(m.health().reachable, undefined);
});

// @spec HOOK-HEALTH-003
test("call outcomes move the reachable flag", async () => {
  let fail = false;
  const p = new FakeProvider(async () => { if (fail) throw new Error("boom"); return '{"out": 1}'; });
  const m = llmModule(p);
  await m.run({ n: 1 });
  assert.equal(m.health().reachable, true);
  fail = true;
  await m.run({ n: 1 });
  assert.equal(m.health().reachable, false);
});

// @spec HOOK-HEALTH-004
test("hookHealth reports mock when a hook inherits the mock provider, and each non-rules hook as a dependency", async () => {
  const live = llmModule(new FakeProvider());
  const mockP = new FakeProvider();
  mockP.name = "mock";
  const onMock = llmModule(mockP);
  const rulesHook = new Module("r", ModuleSchema.parse({ kind: "rules" }), llmCfg, llmImpl, recorder().log);
  assert.equal(hookHealth([live, rulesHook]).mode(), "live");
  assert.equal(hookHealth([live, onMock]).mode(), "mock");
  assert.equal(hookHealth([rulesHook]).mode(), "live");
  const h = hookHealth([live, rulesHook]);
  assert.deepEqual(h.deps(), { "hook.t": "n/a" });
  await live.ping();
  assert.deepEqual(h.deps(), { "hook.t": "ok" });
  const failing = llmModule(new FakeProvider(async () => { throw new Error("down"); }), {}, {});
  for (let n = 0; n < HOOK_COOLOFF_AFTER; n++) await failing.run({ n });
  assert.deepEqual(hookHealth([failing]).deps(), { "hook.t": "down" });
});

// @spec HOOK-HEALTH-005
test("startHooks pings every non-rules hook once and logs the ones that do not answer", async () => {
  const { log, warns } = recorder();
  const good = llmModule(new FakeProvider());
  const badP = new FakeProvider();
  badP.pingResult = false;
  const bad = new Module("bad.hook", ModuleSchema.parse({ kind: "llm" }), llmCfg, llmImpl, log, { provider: badP });
  const { pingHooks } = await import("../src/index.js");
  await pingHooks([good, bad], log);
  assert.equal(good.health().reachable, true);
  assert.equal(bad.health().reachable, false);
  assert.equal(warns.length, 1);
  assert.match(warns[0]!.msg, /bad\.hook.*unreachable/);
});
