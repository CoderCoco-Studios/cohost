import { test, after, mock } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { ModuleSchema } from "@cohost/config";
import { Module, extractJson, clamp, isNum } from "../src/index.js";

const log = { warn() {}, info() {}, error() {}, debug() {} } as never;
const llmCfg = { provider: "ollama", model: "x", embed_model: "x" } as never;
const rules = (i: { n: number }) => ({ out: i.n * 2 });
const validate = (raw: unknown) => {
  const o = (raw as { out?: unknown })?.out;
  return typeof o === "number" ? { out: o } : undefined;
};

// @spec HOOK-HELP-001, HOOK-HELP-002
test("extractJson pulls the first object out of chatty text", () => {
  assert.deepEqual(extractJson('Sure! {"scores":[0.2,1]} hope that helps'), { scores: [0.2, 1] });
  assert.deepEqual(extractJson("[1,2]"), [1, 2]);
  assert.equal(extractJson("nothing here"), undefined);
  assert.equal(extractJson("{broken"), undefined);
});

// @spec HOOK-KIND-001, HOOK-KIND-002
test("kind=rules runs the rules function directly", async () => {
  const m = new Module("t", ModuleSchema.parse({ kind: "rules" }), llmCfg, { rules }, log);
  assert.deepEqual(await m.run({ n: 2 }), { out: 4 });
  assert.equal(m.kind, "rules");
});

// @spec HOOK-KIND-003, HOOK-KIND-005
test("kind=http requires a url; kind=llm requires an llm spec", () => {
  assert.throws(() => new Module("t", ModuleSchema.parse({ kind: "http" }), llmCfg, { rules, http: { validate } }, log), /url is empty/);
  assert.throws(() => new Module("t", ModuleSchema.parse({ kind: "llm" }), llmCfg, { rules }, log), /no llm implementation/);
});

const answers: unknown[] = [];
const server = http.createServer(async (req, res) => {
  let body = ""; for await (const c of req) body += c;
  const a = answers.shift();
  if (a === "hang") return; // never answers → timeout
  if (a === "500") { res.statusCode = 500; return res.end("{}"); }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(a ?? { echo: JSON.parse(body) }));
});
await new Promise<void>((r) => server.listen(0, r));
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/m`;
after(() => server.close());

// @spec HOOK-HTTP-002
test("kind=http posts the input and uses a valid answer", async () => {
  answers.push({ out: 99 });
  const m = new Module("t", ModuleSchema.parse({ kind: "http", url, timeout_ms: 500 }), llmCfg, { rules, http: { validate } }, log);
  assert.deepEqual(await m.run({ n: 2 }), { out: 99 });
});

// @spec HOOK-HTTP-003, HOOK-FALLBACK-001, HOOK-FALLBACK-002
test("kind=http falls back to rules on bad shape, 500 and timeout", async () => {
  const m = new Module("t", ModuleSchema.parse({ kind: "http", url, timeout_ms: 300 }), llmCfg, { rules, http: { validate } }, log);
  answers.push({ nope: true });
  assert.deepEqual(await m.run({ n: 2 }), { out: 4 });
  answers.push("500");
  assert.deepEqual(await m.run({ n: 3 }), { out: 6 });
  answers.push("hang");
  assert.deepEqual(await m.run({ n: 5 }), { out: 10 });
});

// ---- kind=llm, against a fake OpenAI-compatible server

const llmReplies: string[] = [];
let llmBody: Record<string, unknown> = {};
const llmServer = http.createServer(async (req, res) => {
  let body = ""; for await (const c of req) body += c;
  llmBody = JSON.parse(body);
  const content = llmReplies.shift() ?? "";
  if (content === "hang") return;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ choices: [{ message: { content } }] }));
});
await new Promise<void>((r) => llmServer.listen(0, r));
after(() => llmServer.close());
const openaiCfg = {
  provider: "openai", model: "cortex-model", embed_model: "e", temperature: 0.9, max_tokens: 120, num_ctx: 1,
  openai: { base_url: `http://127.0.0.1:${(llmServer.address() as { port: number }).port}/v1`, api_key: "" },
  claude: { api_key: "", effort: "low", max_tokens: 2048, fallbacks: true }, bedrock: { region: "" },
} as never;
const llmImpl = { rules, llm: { system: "score it", user: (i: { n: number }) => `n=${i.n}`, maxTokens: 30, validate } };

// @spec HOOK-LLM-001, HOOK-LLM-003, HOOK-LLM-005
test("kind=llm sends system + user prompt as a deterministic json call and parses chatty replies", async () => {
  const m = new Module("t", ModuleSchema.parse({ kind: "llm" }), openaiCfg, llmImpl, log);
  llmReplies.push('Here you go: {"out": 42}');
  assert.deepEqual(await m.run({ n: 1 }), { out: 42 });
  assert.deepEqual(llmBody.messages, [{ role: "system", content: "score it" }, { role: "user", content: "n=1" }]);
  assert.equal(llmBody.temperature, 0);
  assert.equal(llmBody.max_tokens, 30);
  assert.equal("stop" in llmBody, false);
  assert.equal(llmBody.model, "cortex-model"); // no override: inherits the cortex's model
});

// @spec HOOK-LLM-002
test("kind=llm can use a different model than the cortex", async () => {
  const m = new Module("t", ModuleSchema.parse({ kind: "llm", llm: { model: "tiny" } }), openaiCfg, llmImpl, log);
  llmReplies.push('{"out": 1}');
  await m.run({ n: 1 });
  assert.equal(llmBody.model, "tiny");
});

// @spec HOOK-LLM-004, HOOK-FALLBACK-002, HOOK-FALLBACK-003
test("kind=llm falls back to rules on prose, wrong shape and timeout", async () => {
  const m = new Module("t", ModuleSchema.parse({ kind: "llm", timeout_ms: 200 }), openaiCfg, llmImpl, log);
  llmReplies.push("I think it's about 4");
  assert.deepEqual(await m.run({ n: 2 }), { out: 4 });
  llmReplies.push('{"score": 9}');
  assert.deepEqual(await m.run({ n: 3 }), { out: 6 });
  llmReplies.push("hang");
  const t0 = performance.now();
  assert.deepEqual(await m.run({ n: 4 }), { out: 8 });
  assert.ok(performance.now() - t0 < 1000, "gave up at the hook timeout");
});

// @spec HOOK-WARN-001
test("a module that keeps failing warns once per 30s, not on every call", async () => {
  const warns: unknown[] = [];
  const counting = { info() {}, error() {}, debug() {}, warn: (o: unknown) => warns.push(o) } as never;
  const m = new Module("t", ModuleSchema.parse({ kind: "http", url, timeout_ms: 300 }), llmCfg, { rules, http: { validate } }, counting);
  answers.push("500", "500", { nope: 1 });
  for (let n = 0; n < 3; n++) await m.run({ n });
  assert.deepEqual(warns, [{ module: "t", kind: "http" }]);
});

// @spec HOOK-KIND-004
test("kind=http with no http implementation is a config error", () => {
  assert.throws(() => new Module("t", ModuleSchema.parse({ kind: "http", url }), llmCfg, { rules }, log), /no http implementation/);
});

// @spec HOOK-HELP-004
test("clamp and isNum", () => {
  assert.equal(clamp(5, 0, 1), 1);
  assert.equal(clamp(-5, 0, 1), 0);
  assert.equal(clamp(0.5, 0, 1), 0.5);
  assert.equal(isNum(0), true);
  assert.equal(isNum(NaN), false);
  assert.equal(isNum(Infinity), false);
  assert.equal(isNum("1"), false);
});

// @spec HOOK-WARN-003
test("the next warning after a suppressed window carries the number of suppressed fallbacks", async () => {
  let now = 1_000_000_000_000;
  const clock = mock.method(Date, "now", () => now);
  after(() => clock.mock.restore());
  const warns: Record<string, unknown>[] = [];
  const counting = { info() {}, error() {}, debug() {}, warn: (o: Record<string, unknown>) => warns.push(o) } as never;
  const m = new Module("t", ModuleSchema.parse({ kind: "http", url, timeout_ms: 300 }), llmCfg, { rules, http: { validate } }, counting);
  answers.push("500", "500", "500", "500");
  await m.run({ n: 1 }); // logged
  now += 1_000; await m.run({ n: 2 }); // suppressed
  now += 1_000; await m.run({ n: 3 }); // suppressed
  assert.deepEqual(warns, [{ module: "t", kind: "http" }]);
  now += 30_000; await m.run({ n: 4 }); // window over: logged, with the count
  assert.deepEqual(warns, [{ module: "t", kind: "http" }, { module: "t", kind: "http", suppressed: 2 }]);
  answers.push("500");
  now += 30_000; await m.run({ n: 5 }); // nothing suppressed since: no count field
  assert.deepEqual(warns[2], { module: "t", kind: "http" });
});

// @spec HOOK-WARN-004, HOOK-FALLBACK-006
test("building an llm-kind hook on the mock provider warns once, names the hook, and every call falls back to rules", async () => {
  const warns: { obj: unknown; msg: string }[] = [];
  const logger = { info() {}, error() {}, debug() {}, warn: (obj: unknown, msg: string) => warns.push({ obj, msg }) } as never;
  const mockCfg = { provider: "mock", model: "x", embed_model: "x" } as never;
  const m = new Module("salience.scorer", ModuleSchema.parse({ kind: "llm" }), mockCfg, { rules, llm: { system: "s", user: () => "u", validate } }, logger);
  assert.equal(warns.length, 1);
  assert.deepEqual(warns[0]!.obj, { module: "salience.scorer", kind: "llm" });
  assert.match(warns[0]!.msg, /salience\.scorer.*mock provider.*rules/);
  assert.deepEqual(await m.run({ n: 3 }), { out: 6 }); // {} fails validation: the usual fallback warning follows
  assert.equal(warns.length, 2);
  assert.match(warns[1]!.msg, /unusable/);
  // Only llm-kind hooks resolve a provider, and a real provider does not warn.
  new Module("t", ModuleSchema.parse({ kind: "llm" }), openaiCfg, llmImpl, logger);
  new Module("t", ModuleSchema.parse({ kind: "rules" }), mockCfg, { rules }, logger);
  assert.equal(warns.length, 2);
});

// @spec HOOK-FALLBACK-005
test("impl.rules is called unguarded: a rules function that throws surfaces to the caller on the rules path and as the fallback", async () => {
  const boom = () => { throw new Error("rules exploded"); };
  const direct = new Module("t", ModuleSchema.parse({ kind: "rules" }), llmCfg, { rules: boom }, log);
  await assert.rejects(direct.run({ n: 1 }), /rules exploded/);
  const viaHttp = new Module("t", ModuleSchema.parse({ kind: "http", url, timeout_ms: 300 }), llmCfg, { rules: boom, http: { validate } }, log);
  answers.push("500");
  await assert.rejects(viaHttp.run({ n: 1 }), /rules exploded/);
});

// @spec HOOK-HELP-003
test("extractJson returns the first balanced value: two values, bracketed prose before, brackets in prose after", () => {
  assert.deepEqual(extractJson('{"a":1} then {"b":2}'), { a: 1 });
  assert.deepEqual(extractJson('[1,2] and [3]'), [1, 2]);
  assert.deepEqual(extractJson('Scores for [events] follow: {"scores":[0.5]}'), { scores: [0.5] });
  assert.deepEqual(extractJson('{"ok":true} (see note [1] and the } below)'), { ok: true });
  assert.deepEqual(extractJson('{"note":"a } and ] inside a string","n":[1,{"x":2}]} trailing }'), { note: "a } and ] inside a string", n: [1, { x: 2 }] });
  assert.deepEqual(extractJson('{"q":"say \\"hi}\\""} done'), { q: 'say "hi}"' });
  assert.deepEqual(extractJson('{ not json {"a":1} }'), { a: 1 }); // an unparseable outer span does not hide the value inside it
  assert.equal(extractJson("[unclosed"), undefined);
  assert.equal(extractJson("only [prose] here"), undefined);
});
