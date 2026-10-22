import { test, after } from "node:test";
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

test("extractJson pulls the first object out of chatty text", () => {
  assert.deepEqual(extractJson('Sure! {"scores":[0.2,1]} hope that helps'), { scores: [0.2, 1] });
  assert.deepEqual(extractJson("[1,2]"), [1, 2]);
  assert.equal(extractJson("nothing here"), undefined);
  assert.equal(extractJson("{broken"), undefined);
});

test("kind=rules runs the rules function directly", async () => {
  const m = new Module("t", ModuleSchema.parse({ kind: "rules" }), llmCfg, { rules }, log);
  assert.deepEqual(await m.run({ n: 2 }), { out: 4 });
  assert.equal(m.kind, "rules");
});

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

test("kind=http posts the input and uses a valid answer", async () => {
  answers.push({ out: 99 });
  const m = new Module("t", ModuleSchema.parse({ kind: "http", url, timeout_ms: 500 }), llmCfg, { rules, http: { validate } }, log);
  assert.deepEqual(await m.run({ n: 2 }), { out: 99 });
});

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

test("kind=llm can use a different model than the cortex", async () => {
  const m = new Module("t", ModuleSchema.parse({ kind: "llm", llm: { model: "tiny" } }), openaiCfg, llmImpl, log);
  llmReplies.push('{"out": 1}');
  await m.run({ n: 1 });
  assert.equal(llmBody.model, "tiny");
});

test("kind=llm falls back to rules on prose, wrong shape and timeout", async () => {
  const m = new Module("t", ModuleSchema.parse({ kind: "llm", timeout_ms: 200 }), openaiCfg, llmImpl, log);
  llmReplies.push("I think it's about 4");
  assert.deepEqual(await m.run({ n: 2 }), { out: 4 });
  llmReplies.push('{"score": 9}');
  assert.deepEqual(await m.run({ n: 3 }), { out: 6 });
  llmReplies.push("hang");
  const t0 = Date.now();
  assert.deepEqual(await m.run({ n: 4 }), { out: 8 });
  assert.ok(Date.now() - t0 < 1000, "gave up at the hook timeout");
});

test("a module that keeps failing warns once per 30s, not on every call", async () => {
  const warns: unknown[] = [];
  const counting = { info() {}, error() {}, debug() {}, warn: (o: unknown) => warns.push(o) } as never;
  const m = new Module("t", ModuleSchema.parse({ kind: "http", url, timeout_ms: 300 }), llmCfg, { rules, http: { validate } }, counting);
  answers.push("500", "500", { nope: 1 });
  for (let n = 0; n < 3; n++) await m.run({ n });
  assert.deepEqual(warns, [{ module: "t", kind: "http" }]);
});

test("kind=http with no http implementation is a config error", () => {
  assert.throws(() => new Module("t", ModuleSchema.parse({ kind: "http", url }), llmCfg, { rules }, log), /no http implementation/);
});

test("clamp and isNum", () => {
  assert.equal(clamp(5, 0, 1), 1);
  assert.equal(clamp(-5, 0, 1), 0);
  assert.equal(clamp(0.5, 0, 1), 0.5);
  assert.equal(isNum(0), true);
  assert.equal(isNum(NaN), false);
  assert.equal(isNum(Infinity), false);
  assert.equal(isNum("1"), false);
});
