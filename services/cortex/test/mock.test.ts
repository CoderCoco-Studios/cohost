import { test } from "node:test";
import assert from "node:assert/strict";
import { ModuleSchema } from "@cohost/config";
import { Module } from "@cohost/modules";
import { MockProvider, type ChatProvider } from "@cohost/llm";
import { EMOTIONS } from "@cohost/config";
import { FakeBus, event, recordingLog, silentLog, testConfig, waitFor } from "@cohost/testing";
import { Cortex } from "../src/cortex.js";
import type { CriticInput, CriticOutput } from "../src/critic.js";
import { waitForLlm } from "../src/startup.js";

const critic = new Module<CriticInput, CriticOutput>("critic", ModuleSchema.parse({}), {} as never, { rules: () => ({ ok: true }) }, silentLog);
const focus = { reason: "mentioned", score: 1, focus: { kind: "chat" as const, who: "bob", text: "hey Coco, how are you?", mention: true } };

function setup(cfgOver: Record<string, unknown> = {}) {
  const cfg = testConfig({ llm: { provider: "mock" }, ...cfgOver });
  const bus = new FakeBus();
  const cortex = new Cortex({ cfg, bus, llm: new MockProvider(cfg.llm), critic, log: recordingLog().log, loadPersonality: () => "You are Coco." });
  return { bus, cortex };
}

test("mock provider: attention.focus produces a brain.say with text and a valid emotion", async () => {
  const { bus, cortex } = setup({ brain: { memory: { recall_k: 0 } } });
  await cortex.think(focus);
  const [say] = bus.of("brain.say");
  assert.ok(say!.text.length > 0);
  assert.ok((EMOTIONS as readonly string[]).includes(say!.emotion));
});

test("no memory region: recall times out after recall_timeout_ms and the cortex still speaks", async () => {
  const { bus, cortex } = setup({ brain: { memory: { recall_k: 3 }, cortex: { recall_timeout_ms: 50 } } });
  await cortex.think(focus);
  await waitFor(() => bus.of("memory.recall.request").length === 1, "recall request");
  assert.equal(bus.of("brain.say").length, 1);
});

test("waitForLlm: mock answers at once; a dead backend is logged and reported degraded until it recovers", async () => {
  let downs: string[] = [];
  await waitForLlm(new MockProvider({ model: "m" }), { log: silentLog, onDown: (d) => downs.push(d) });
  assert.deepEqual(downs, []);

  let n = 0;
  const flaky: ChatProvider = { name: "ollama", model: "q", chat: async () => "", ping: async () => ++n > 2, lastError: "cannot reach ollama" };
  const oks: boolean[] = [];
  downs = [];
  await waitForLlm(flaky, { log: silentLog, setOk: (o) => oks.push(o), onDown: (d) => downs.push(d), sleep: async () => {} });
  assert.deepEqual(oks, [false, false, true]);
  assert.equal(downs.length, 2);
  assert.match(downs[0]!, /ollama\/q.*cannot reach ollama/);
});
