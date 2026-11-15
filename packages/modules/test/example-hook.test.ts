/**
 * The shout hook, a complete hook built the way the region hooks are, run with each kind: `rules` directly,
 * `http` against a stub server, `llm` through a fake chat provider. The file under test, which the docs page
 * Add a brain hook shows:
 * examples/new-hook/shout.ts
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ChatProvider } from "@cohost/llm";
import type { Module } from "../src/index.js";

// The example is outside this project's rootDir, so it is loaded at run time; `tsc -p examples/tsconfig.json`
// checks it.
const file = fileURLToPath(new URL("../../../examples/new-hook/shout.ts", import.meta.url));
const { createShoutHook } = (await import(pathToFileURL(file).href)) as {
  createShoutHook: (
    cfg: never, llmCfg: never, log: never, opts?: { provider: ChatProvider },
  ) => Module<{ text: string }, { shouting: boolean }>;
};

const log = { info() {}, error() {}, debug() {}, warn() {} } as never;
const llmCfg = { provider: "mock", model: "m", embed_model: "e" } as never;
const rulesCfg = { kind: "rules", url: "", timeout_ms: 1000, llm: { provider: "", model: "" } } as never;

let answer: unknown = { shouting: true };
const stub = http.createServer(async (req, res) => {
  for await (const _ of req);
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(answer));
});
await new Promise<void>((r) => stub.listen(0, r));
after(() => stub.close());
const httpCfg = { kind: "http", url: `http://127.0.0.1:${(stub.address() as { port: number }).port}/m`, timeout_ms: 1000, llm: { provider: "", model: "" } } as never;

// @spec HOOK-EX-017
test("createShoutHook returns a Module whose rules kind answers directly", async () => {
  const hook = createShoutHook(rulesCfg, llmCfg, log);
  assert.equal(hook.kind, "rules");
  assert.equal(hook.health().name, "shout");
  assert.deepEqual(await hook.run({ text: "WATCH OUT" }), { shouting: true });
});

// @spec HOOK-EX-018
test("rules: shouting means three or more cased letters and none lower case", async () => {
  const hook = createShoutHook(rulesCfg, llmCfg, log);
  const yes = ["ABC", "WATCH OUT!!!", "123 ABC 456", "ÉCOUTEZ", "ΑΒΓ", "\ud800 ABC"];
  const no = ["", "AB", "ABc", "hello", "!!! 123", "Hello WORLD", "日本語"];
  for (const text of yes) assert.deepEqual(await hook.run({ text }), { shouting: true }, text);
  for (const text of no) assert.deepEqual(await hook.run({ text }), { shouting: false }, text);
});

// @spec HOOK-EX-019
test("http: a well-formed reply is used, anything else falls back to the rules answer", async () => {
  const hook = createShoutHook(httpCfg, llmCfg, log);
  answer = { shouting: false, extra: 1 };
  assert.deepEqual(await hook.run({ text: "LOUD TEXT" }), { shouting: false });
  for (const bad of [[], { shouting: "yes" }, { other: true }, "x", null, 3, [{ shouting: true }]]) {
    answer = bad;
    assert.deepEqual(await hook.run({ text: "LOUD TEXT" }), { shouting: true }, JSON.stringify(bad));
    assert.deepEqual(await hook.run({ text: "quiet" }), { shouting: false });
  }
});

// @spec HOOK-EX-017, HOOK-EX-019
test("llm: the JSON the runner extracts is validated the same way", async () => {
  let reply = 'Sure! {"shouting": false}';
  const provider = {
    name: "fake", lastError: undefined, pingIsNominal: false,
    async chat() { return reply; },
    async ping() { return true; },
  } as unknown as ChatProvider;
  const llmHook = { kind: "llm", url: "", timeout_ms: 1000, llm: { provider: "", model: "" } } as never;
  const hook = createShoutHook(llmHook, llmCfg, log, { provider });
  assert.deepEqual(await hook.run({ text: "LOUD TEXT" }), { shouting: false });
  reply = '{"shouting": "no"}';
  assert.deepEqual(await hook.run({ text: "LOUD TEXT" }), { shouting: true });
  reply = "[true]";
  assert.deepEqual(await hook.run({ text: "quiet" }), { shouting: false });
});
