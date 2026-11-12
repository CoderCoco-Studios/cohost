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
  calls: ChatMessage[][] = [];
  reply: (msgs: ChatMessage[]) => string | Promise<string> = () => "[happy] hey chat!";
  async chat(msgs: ChatMessage[]) { this.calls.push(msgs); return this.reply(msgs); }
  async ping() { return true; }
  get system() { return this.calls.at(-1)![0]!.content; }
}
const critic = () => new Module<CriticInput, CriticOutput>("critic", ModuleSchema.parse({}), {} as never, { rules: () => ({ ok: true }) }, silentLog);

function setup(over: Record<string, unknown> = {}) {
  const cfg = testConfig({ brain: { memory: { recall_k: 0 }, cortex: { recall_timeout_ms: 100 } }, ...over });
  const bus = new FakeBus();
  const llm = new FakeLlm();
  const details: (string | undefined)[] = [];
  const cortex = new Cortex({ cfg, bus, llm, critic: critic(), log: silentLog, loadPersonality: () => "You are Coco.", heartbeat: { setDetail: (d) => details.push(d) } });
  return { cfg, bus, llm, cortex, details, statuses: () => bus.of("brain.status").map((s) => s.state) };
}
const mention = (who = "bob", text = "hey Coco, how are you?") =>
  ({ reason: "mentioned", score: 1, focus: { kind: "chat" as const, who, text, mention: true } });
const operatorSay = (text: string) => event("control", { cmd: "say", text });

// ---- D1: an operator say over a pending line

test("an operator say over a pending line keeps that line pending: its voice.done is reconciled, idle only after both end", async () => { // @spec CTX-SAY-005, CTX-EVT-005, CTX-CTRL-006
  const { cortex, bus, llm, statuses } = setup();
  await cortex.onEvent(event("brain.say", { id: "reflex-1", text: "Oof.", emotion: "surprised" }, "salience"));
  await cortex.onEvent(operatorSay("Welcome everyone"));
  const [operator] = bus.of("brain.say");
  assert.equal(operator!.text, "Welcome everyone");
  assert.equal(operator!.emotion, "neutral");
  assert.equal(operator!.reason, "operator");

  await cortex.onEvent(event("voice.done", { id: "reflex-1", sink: "x" })); // the interrupted line ends first
  await cortex.think(mention());
  assert.equal(llm.calls.length, 0, "the operator's line is still playing");
  assert.ok(!statuses().includes("idle"), "not reported idle while a line plays");

  await cortex.onEvent(event("voice.done", { id: operator!.id, sink: "x" }));
  assert.equal(statuses().at(-1), "idle");
  await cortex.think(mention());
  assert.equal(llm.calls.length, 1);
});

test("the operator's line ending first does not free the cortex while the interrupted line plays", async () => { // @spec CTX-SAY-005, CTX-EVT-005
  const { cortex, bus, llm, statuses } = setup();
  await cortex.onEvent(event("brain.say", { id: "reflex-1", text: "Oof.", emotion: "surprised" }, "salience"));
  await cortex.onEvent(operatorSay("Quick note"));
  await cortex.onEvent(event("voice.done", { id: bus.of("brain.say")[0]!.id, sink: "x" }));
  assert.ok(!statuses().includes("idle"));
  await cortex.think(mention());
  assert.equal(llm.calls.length, 0);
  await cortex.onEvent(event("voice.done", { id: "reflex-1", sink: "x" }));
  assert.equal(statuses().at(-1), "idle");
});

test("an operator say bypasses mute, pause and a busy voice; without text it does nothing", async () => { // @spec CTX-CTRL-006
  const { cortex, bus } = setup();
  await cortex.onEvent(event("control", { cmd: "mute" }));
  await cortex.onEvent(event("control", { cmd: "pause" }));
  await cortex.onEvent(event("brain.say", { id: "playing", text: "x", emotion: "neutral" }, "salience"));
  await cortex.onEvent(operatorSay("Still goes out"));
  assert.deepEqual(bus.of("brain.say").map((s) => s.text), ["Still goes out"]);
  await cortex.onEvent(event("control", { cmd: "say" }));
  await cortex.onEvent(event("control", { cmd: "say", text: "" }));
  assert.equal(bus.of("brain.say").length, 1);
});

// ---- D4: the coverage gaps

test("with recall_k 0 no recall request is published, even with a vision line to query by", async () => { // @spec CTX-RECALL-002
  const { cortex, bus, llm } = setup();
  await cortex.onEvent(event("vision.summary", { text: "a dragon appears", changed: true }));
  await cortex.think({ reason: "engaged", score: 1 });
  assert.equal(llm.calls.length, 1);
  assert.equal(bus.of("memory.recall.request").length, 0);
});

test("viewer notes are capped at 50: the oldest note is evicted first", async () => { // @spec CTX-VIEWER-002
  const { cortex, llm, bus } = setup();
  for (let i = 0; i <= 50; i++) await cortex.onEvent(event("memory.viewer", { user: `user${i}`, isNew: true, msgCount: 1, regular: false }));
  const done = async () => cortex.onEvent(event("voice.done", { id: bus.of("brain.say").at(-1)!.id, sink: "x" }));
  await cortex.think(mention("user0")); // 51 notes were stored: the first is gone
  assert.doesNotMatch(llm.system, /user0 is new here/);
  await done();
  await cortex.think(mention("user1"));
  assert.match(llm.system, /user1 is new here/);
  await done();
  await cortex.think(mention("user50"));
  assert.match(llm.system, /user50 is new here/);
});

test("a reply that comes back after a pause is dropped and the cortex reports muted", async () => { // @spec CTX-GATE-005
  const { cortex, bus, llm, statuses } = setup();
  let release!: () => void;
  llm.reply = () => new Promise((r) => { release = () => r("[happy] too late"); });
  const thinking = cortex.think(mention());
  await waitFor(() => llm.calls.length === 1, "the llm call");
  await cortex.onEvent(event("control", { cmd: "pause" }));
  release();
  await thinking;
  assert.equal(bus.of("brain.say").length, 0);
  assert.equal(statuses().at(-1), "muted");
});

test("pause is reported in the heartbeat detail and cleared by resume", async () => { // @spec CTX-HEALTH-005
  const { cortex, details } = setup();
  await cortex.onEvent(event("control", { cmd: "pause", target: "salience" }));
  assert.deepEqual(details, []);
  await cortex.onEvent(event("control", { cmd: "pause" }));
  await cortex.onEvent(event("control", { cmd: "resume" }));
  assert.deepEqual(details, ["paused", undefined]);
});

test("the cortex window is sized by brain.working_memory_events", async () => { // @spec WM-WIN-005
  const { cortex } = setup({ brain: { working_memory_events: 3, memory: { recall_k: 0 } } });
  for (const t of ["a", "b", "c", "d", "e"]) {
    await cortex.onEvent(event("chat.message", { platform: "twitch", user: "bob", text: t, isMod: false, isSub: false, mentionsCohost: false }));
  }
  assert.deepEqual(cortex.ctx.all().map((e) => (e as { text: string }).text), ["c", "d", "e"]);
});
