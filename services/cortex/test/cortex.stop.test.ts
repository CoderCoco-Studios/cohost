import { test } from "node:test";
import assert from "node:assert/strict";
import { ModuleSchema } from "@cohost/config";
import { Module } from "@cohost/modules";
import type { ChatMessage, ChatProvider } from "@cohost/llm";
import { FakeBus, event, silentLog, testConfig, waitFor } from "@cohost/testing";
import { Cortex } from "../src/cortex.js";
import type { CriticInput, CriticOutput } from "../src/critic.js";

// voice.stop on the cortex (CTX-EVT-010, CTX-GATE-010, CTX-GATE-011): it ends lines and releases the status; it never touches a think.

class FakeLlm implements ChatProvider {
  readonly name = "fake";
  readonly model = "fake";
  calls: ChatMessage[][] = [];
  gate: Promise<void> | undefined;
  reply: (msgs: ChatMessage[]) => string = () => "[happy] hey chat!";
  async chat(msgs: ChatMessage[]) { this.calls.push(msgs); if (this.gate) await this.gate; return this.reply(msgs); }
  async ping() { return true; }
}
const critic = () => new Module<CriticInput, CriticOutput>("critic", ModuleSchema.parse({}), {} as never, { rules: () => ({ ok: true }) }, silentLog);

function setup() {
  const cfg = testConfig({ brain: { memory: { recall_k: 0 }, cortex: { recall_timeout_ms: 100 } } });
  const bus = new FakeBus();
  const llm = new FakeLlm();
  const cortex = new Cortex({ cfg, bus, llm, critic: critic(), log: silentLog, loadPersonality: () => "You are Coco.", heartbeat: { setDetail: () => {} } });
  return { bus, llm, cortex, statuses: () => bus.of("brain.status").map((s) => s.state) };
}
const mention = () => ({ reason: "mentioned", score: 1, focus: { kind: "chat" as const, who: "bob", text: "hey Coco, how are you?", mention: true } });
const stop = (ids?: string[]) => event("voice.stop" as never, { reason: "barge-in", ...(ids ? { ids } : {}) } as never);
const line = (id: string) => event("brain.say", { id, text: "Oof.", emotion: "surprised", reason: "reflex: died" }, "salience");
const done = (id: string, extra: Record<string, unknown> = {}) => event("voice.done", { id, sink: "discord", ...extra } as never);

// @spec CTX-EVT-010
test("a voice.stop without ids ends every pending line and publishes idle once none is pending", async () => {
  const { cortex, statuses } = setup();
  await cortex.onEvent(line("a"));
  await cortex.onEvent(line("b"));
  const before = statuses().length;
  await cortex.onEvent(stop());
  assert.equal(statuses().length, before + 1, "one status for the stop");
  assert.equal(statuses().at(-1), "idle");
});

// @spec CTX-EVT-010
test("a voice.stop with ids ends only those lines; idle is published only when the last pending line ends", async () => {
  const { cortex, statuses } = setup();
  await cortex.onEvent(line("a"));
  await cortex.onEvent(line("b"));
  const before = statuses().length;
  await cortex.onEvent(stop(["a"]));
  assert.equal(statuses().length, before, "b is still pending: no status");
  await cortex.onEvent(stop(["b"]));
  assert.equal(statuses().at(-1), "idle");
  assert.equal(statuses().length, before + 1);
});

// @spec CTX-EVT-010
test("a voice.stop ends the cortex's own pending line too", async () => {
  const { cortex, bus, statuses } = setup();
  await cortex.think(mention());
  const own = bus.of("brain.say")[0]!;
  await cortex.onEvent(event("brain.say", own as never, "cortex")); // the echo of its own line
  await cortex.onEvent(stop([own.id]));
  assert.equal(statuses().at(-1), "idle");
});

// @spec CTX-EVT-010
test("with the cortex muted or paused the release is muted, not idle", async () => {
  for (const cmd of ["mute", "pause"] as const) {
    const { cortex, statuses } = setup();
    await cortex.onEvent(line("a"));
    await cortex.onEvent(event("control", { cmd }));
    await cortex.onEvent(stop());
    assert.equal(statuses().at(-1), "muted", cmd);
  }
});

// @spec CTX-EVT-010
test("a voice.stop that ends no pending line publishes no brain.status", async () => {
  const { cortex, bus } = setup();
  await cortex.onEvent(stop());
  await cortex.onEvent(stop(["nope"]));
  assert.deepEqual(bus.of("brain.status"), []);
  await cortex.onEvent(line("a"));
  const before = bus.of("brain.status").length;
  await cortex.onEvent(stop(["other"]));
  await cortex.onEvent(stop([]));
  assert.equal(bus.of("brain.status").length, before);
});

// @spec CTX-GATE-010
test("a voice.stop neither cancels, restarts nor starts a think: the one in flight completes and its reply is spoken as usual", async () => {
  const { cortex, bus, llm } = setup();
  let release!: () => void;
  llm.gate = new Promise<void>((r) => { release = r; });
  const thinking = cortex.think(mention());
  await waitFor(() => llm.calls.length === 1, "the think is in flight");
  await cortex.onEvent(stop());
  assert.equal(llm.calls.length, 1, "no restart, no new think for the stop");
  release();
  await thinking;
  assert.equal(llm.calls.length, 1);
  assert.equal(bus.of("brain.say").length, 1, "the reply is published");
});

// @spec CTX-GATE-010, CTX-GATE-005
test("a think in flight across a voice.stop still has its reply dropped when the cortex was muted meanwhile", async () => {
  const { cortex, bus, llm, statuses } = setup();
  let release!: () => void;
  llm.gate = new Promise<void>((r) => { release = r; });
  const thinking = cortex.think(mention());
  await waitFor(() => llm.calls.length === 1, "in flight");
  await cortex.onEvent(event("control", { cmd: "mute" }));
  await cortex.onEvent(stop());
  release();
  await thinking;
  assert.equal(bus.of("brain.say").length, 0);
  assert.equal(statuses().at(-1), "muted");
});

// @spec CTX-GATE-011
test("a voice.done flagged interrupted for a line a voice.stop already ended is ignored: no status, no pending change", async () => {
  const { cortex, statuses } = setup();
  await cortex.onEvent(line("a"));
  await cortex.onEvent(line("b"));
  await cortex.onEvent(stop(["a"]));
  const before = statuses().length;
  await cortex.onEvent(done("a", { interrupted: true }));
  assert.equal(statuses().length, before, "ignored");
  await cortex.onEvent(done("b"));
  assert.equal(statuses().at(-1), "idle", "b was still pending until its own done");
  const again = statuses().length;
  await cortex.onEvent(stop());
  await cortex.onEvent(done("b", { interrupted: true }));
  assert.equal(statuses().length, again, "nothing pending, nothing published");
});
