import { test } from "node:test";
import assert from "node:assert/strict";
import type { BusEvent } from "@cohost/bus";
import { ModuleSchema } from "@cohost/config";
import { Module } from "@cohost/modules";
import type { ChatMessage, ChatProvider } from "@cohost/llm";
import { FakeBus, silentLog, testConfig } from "@cohost/testing";
import { Cortex } from "../src/cortex.js";
import { startCortex } from "../src/startup.js";
import type { CriticInput, CriticOutput } from "../src/critic.js";

class CountingLlm implements ChatProvider {
  readonly name = "fake";
  readonly model = "fake";
  calls = 0;
  async chat(_m: ChatMessage[]) { this.calls++; return "[happy] hi!"; }
  async ping() { return true; }
}

// @spec CTX-EVT-009
test("the cortex subscription does not include speech.partial, and speech.heard stays in it", async () => {
  let types: string[] = [];
  await startCortex({
    bus: { resetGroup: async () => {}, subscribe: async (o: { types: readonly string[] }) => { types = [...o.types]; } } as never,
    cortex: { status: async () => {}, onEvent: async () => {} } as never,
    heartbeat: { ready() {} }, onFatal: () => {},
  });
  assert.ok(types.includes("speech.heard"));
  assert.ok(!types.includes("speech.partial"));
});

// @spec CTX-EVT-009
test("a speech.partial handed to the cortex is not added to its window and starts no think", async () => {
  const cfg = testConfig({ brain: { memory: { recall_k: 0 } } });
  const llm = new CountingLlm();
  const critic = new Module<CriticInput, CriticOutput>("critic", ModuleSchema.parse({}), {} as never, { rules: async () => ({ ok: true }) }, silentLog);
  const bus = new FakeBus();
  const cortex = new Cortex({ cfg, bus, llm, critic, log: silentLog, loadPersonality: () => "You are Coco." });
  const partial = { id: "1-0", type: "speech.partial", ts: Date.now(), source: "ears", data: { speaker: "Chris", source: "discord", text: "hey Coco how are you", utteranceId: "u1", seq: 0 } } as unknown as BusEvent;
  await cortex.onEvent(partial);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(llm.calls, 0);
  assert.equal(bus.of("brain.say").length, 0);
  const ctx = (cortex as unknown as { ctx: { all(): readonly unknown[] } }).ctx;
  assert.equal(ctx.all().length, 0, "nothing in the working-memory window");
});
