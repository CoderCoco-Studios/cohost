import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { ModuleSchema } from "@cohost/config";
import { Module, extractJson } from "../src/index.js";

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
