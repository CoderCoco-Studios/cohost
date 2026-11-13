import { test } from "node:test";
import assert from "node:assert/strict";
import { ModuleSchema } from "@cohost/config";
import { Module } from "@cohost/modules";
import type { ChatMessage, ChatProvider } from "@cohost/llm";
import { FakeBus, event, silentLog, testConfig, waitFor } from "@cohost/testing";
import { Cortex } from "../src/cortex.js";
import type { CriticInput, CriticOutput } from "../src/critic.js";

class FakeLlm implements ChatProvider {
  readonly name = "fake";
  readonly model = "fake";
  async chat(_m: ChatMessage[]) { await new Promise((r) => setTimeout(r, 15)); return "[happy] hey chat!"; }
  async ping() { return true; }
}

function setup(critic: (i: CriticInput) => CriticOutput | Promise<CriticOutput> = () => ({ ok: true }), module?: Module<CriticInput, CriticOutput>) {
  const cfg = testConfig({ brain: { memory: { recall_k: 0 }, cortex: { recall_timeout_ms: 100 } } });
  const bus = new FakeBus();
  const m = module ?? new Module<CriticInput, CriticOutput>("critic", ModuleSchema.parse({}), {} as never, { rules: async (i) => critic(i) }, silentLog);
  const cortex = new Cortex({ cfg, bus, llm: new FakeLlm(), critic: m, log: silentLog, loadPersonality: () => "You are Coco." });
  return { cortex, bus };
}
const focus = (timing?: Record<string, number>) =>
  event("attention.focus", { reason: "mentioned", score: 1, focus: { kind: "speech", who: "Chris", text: "hey Coco, how are you?", mention: false }, ...(timing ? { timing } : {}) });

// @spec CTX-SAY-006, BUS-EVT-025
test("brain.say copies the focus timing unchanged and adds focusedAt = the attention.focus envelope ts", async () => {
  const { cortex, bus } = setup();
  const f = focus({ audioEndedAt: 111, heardAt: 222 });
  await cortex.onEvent(f);
  await waitFor(() => bus.of("brain.say").length === 1, "brain.say");
  const t = bus.of("brain.say")[0]!.timing!;
  assert.equal(t.audioEndedAt, 111);
  assert.equal(t.heardAt, 222);
  assert.equal(t.focusedAt, f.ts);
});

// @spec CTX-SAY-006
test("a focus without timing still gets focusedAt and no copied stamps", async () => {
  const { cortex, bus } = setup();
  const f = focus();
  await cortex.onEvent(f);
  await waitFor(() => bus.of("brain.say").length === 1, "brain.say");
  const t = bus.of("brain.say")[0]!.timing!;
  assert.equal(t.focusedAt, f.ts);
  assert.equal(t.audioEndedAt, undefined);
  assert.equal(t.heardAt, undefined);
});

// @spec CTX-SAY-007
test("llmStartedAt and llmEndedAt bracket the reply call, in order, and an operator say carries neither", async () => {
  const { cortex, bus } = setup();
  const before = Date.now();
  await cortex.onEvent(focus({ audioEndedAt: 1 }));
  await waitFor(() => bus.of("brain.say").length === 1, "brain.say");
  const after = Date.now();
  const t = bus.of("brain.say")[0]!.timing!;
  assert.ok(t.llmStartedAt! >= before && t.llmStartedAt! <= t.llmEndedAt! && t.llmEndedAt! <= after, JSON.stringify(t));
  assert.ok(t.llmEndedAt! - t.llmStartedAt! >= 10, "spans the 15 ms reply call");

  await cortex.onEvent(event("control", { cmd: "say", text: "hello from the operator" }));
  await waitFor(() => bus.of("brain.say").length === 2, "operator say");
  const op = bus.of("brain.say")[1]!.timing;
  assert.equal(op?.llmStartedAt, undefined);
  assert.equal(op?.llmEndedAt, undefined);
});

// @spec CTX-SAY-008, CTX-SAY-007
test("criticEndedAt is set when the critic ran, after llmEndedAt and covering the critic's call", async () => {
  const { cortex, bus } = setup(async () => { await new Promise((r) => setTimeout(r, 20)); return { ok: true }; });
  await cortex.onEvent(focus());
  await waitFor(() => bus.of("brain.say").length === 1, "brain.say");
  const t = bus.of("brain.say")[0]!.timing!;
  assert.ok(t.criticEndedAt !== undefined, "critic stamp present");
  assert.ok(t.criticEndedAt! - t.llmEndedAt! >= 15, `critic call is outside llmEndedAt: ${JSON.stringify(t)}`);
});

// @spec CTX-SAY-008
test("criticEndedAt is set when the critic hook falls back, and absent when it did not run", async () => {
  const failing: ChatProvider = { name: "fake", model: "fake", chat: async () => { throw new Error("critic llm down"); }, ping: async () => true };
  const llmCritic = new Module<CriticInput, CriticOutput>(
    "critic", ModuleSchema.parse({ kind: "llm" }), testConfig().llm,
    { rules: () => ({ ok: true }), llm: { system: "s", user: () => "u", validate: () => undefined } }, silentLog, { provider: failing },
  );
  const thrown = setup(undefined, llmCritic);
  await thrown.cortex.onEvent(focus());
  await waitFor(() => thrown.bus.of("brain.say").length === 1, "brain.say after fallback");
  assert.ok(thrown.bus.of("brain.say")[0]!.timing!.criticEndedAt !== undefined);

  const operator = setup();
  await operator.cortex.onEvent(event("control", { cmd: "say", text: "hello from the operator" }));
  await waitFor(() => operator.bus.of("brain.say").length === 1, "operator say");
  assert.equal(operator.bus.of("brain.say")[0]!.timing?.criticEndedAt, undefined);
});
