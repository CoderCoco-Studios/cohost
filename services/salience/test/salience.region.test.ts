import { test } from "node:test";
import assert from "node:assert/strict";
import { ModuleSchema } from "@cohost/config";
import { Module } from "@cohost/modules";
import { FakeBus, event, silentLog, testConfig } from "@cohost/testing";
import { Salience } from "../src/salience.js";
import { scoreRules, type ScoreInput, type ScoreOutput } from "../src/scoring.js";

const DIED = { match: "you died", say: ["Oof."], emotion: "surprised", gesture: "facepalm", cooldown_ms: 0 };

function setup(salience: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const cfg = testConfig({ brain: { salience: { cooldown_ms: 0, idle_chatter_ms: 0, ...salience } }, ...extra });
  const bus = new FakeBus();
  let scorerCalls = 0;
  let gate: Promise<void> | undefined;
  const scorer = new Module<ScoreInput, ScoreOutput>("s", ModuleSchema.parse({}), cfg.llm, {
    rules: (i) => { scorerCalls++; return scoreRules(i, true); },
  }, silentLog);
  const run = scorer.run.bind(scorer);
  scorer.run = async (i) => { if (gate) await gate; return run(i); };
  const s = new Salience({ cfg, bus, scorer, log: silentLog });
  return { s, bus, calls: () => scorerCalls, setGate: (g?: Promise<void>) => { gate = g; } };
}
const chat = (text: string, extra: Record<string, unknown> = {}) =>
  event("chat.message", { platform: "twitch", user: "bob", text, isMod: false, isSub: false, mentionsCohost: false, ...extra });
const idle = event("brain.status", { state: "idle" });

test("tick: a mention publishes attention.focus naming who and what", async () => {
  const { s, bus } = setup();
  await s.onEvent(chat("plain"));
  await s.onEvent(chat("hey Coco?", { mentionsCohost: true }));
  await s.tick();
  const [focus] = bus.of("attention.focus");
  assert.equal(focus!.reason, "mentioned");
  assert.ok(Math.abs(focus!.score - 1.15) < 1e-9);
  assert.deepEqual(focus!.focus, { kind: "chat", who: "bob", text: "hey Coco?", mention: true });
  assert.equal(s.ctx.unseen().length, 0, "what was scored is now seen");
});

test("tick: speech and vision focus are mapped for the cortex", async () => {
  const sp = setup();
  await sp.s.onEvent(event("speech.heard", { speaker: "Chris", text: "look at this", durationMs: 900 }));
  await sp.s.tick();
  assert.deepEqual(sp.bus.of("attention.focus")[0]!.focus, { kind: "speech", who: "Chris", text: "look at this", mention: false });

  const vi = setup({ speak_threshold: 0.3 });
  await vi.s.onEvent(event("vision.summary", { text: "a dragon appears", changed: true }));
  await vi.s.tick();
  assert.deepEqual(vi.bus.of("attention.focus")[0]!.focus, { kind: "vision", text: "a dragon appears", mention: false });
});

test("tick: after firing, it treats the cortex as busy until the cortex reports back", async () => {
  const { s, bus } = setup();
  await s.onEvent(chat("hey Coco?", { mentionsCohost: true }));
  await s.tick();
  await s.onEvent(chat("Coco again?", { mentionsCohost: true }));
  await s.tick();
  assert.equal(bus.of("attention.focus").length, 1);
  await s.onEvent(idle);
  await s.tick();
  assert.equal(bus.of("attention.focus").length, 2);
});

test("a speaking cortex blocks focus until done, with a speaking_timeout_ms safety valve", async () => {
  const { s, bus } = setup({}, { brain: { salience: { cooldown_ms: 0, idle_chatter_ms: 0 }, cortex: { speaking_timeout_ms: 30 } } });
  await s.onEvent(event("brain.say", { id: "x", text: "hi", emotion: "happy" }));
  await s.onEvent(chat("hey Coco?", { mentionsCohost: true }));
  await s.tick();
  assert.equal(bus.of("attention.focus").length, 0);
  await new Promise((r) => setTimeout(r, 40));
  await s.tick();
  assert.equal(bus.of("attention.focus").length, 1);
});

test("brain.say from anyone starts the cooldown", async () => {
  const { s, bus } = setup({ cooldown_ms: 60_000 });
  await s.onEvent(event("brain.say", { id: "x", text: "hi", emotion: "happy" }));
  await s.onEvent(idle);
  await s.onEvent(chat("hey Coco?", { mentionsCohost: true }));
  await s.tick();
  assert.equal(bus.of("attention.focus").length, 0);
});

test("mute / unmute / forget_context", async () => {
  const { s, bus } = setup();
  await s.onEvent(event("control", { cmd: "mute" }));
  await s.onEvent(chat("hey Coco?", { mentionsCohost: true }));
  await s.tick();
  assert.equal(bus.of("attention.focus").length, 0);
  await s.onEvent(event("control", { cmd: "forget_context" }));
  assert.equal(s.ctx.all().length, 0);
  await s.onEvent(event("control", { cmd: "unmute" }));
  await s.onEvent(chat("hey Coco?", { mentionsCohost: true }));
  await s.tick();
  assert.equal(bus.of("attention.focus").length, 1);
});

test("an excited mood lowers the bar to speak", async () => {
  const { s, bus } = setup({ speak_threshold: 0.6, arousal_bias: 0.5 });
  for (const t of ["a", "b", "c"]) await s.onEvent(chat(t)); // 0.45
  await s.tick();
  assert.equal(bus.of("attention.focus").length, 0);
  await s.onEvent(event("affect.state", { valence: 0.5, arousal: 1, mood: "laugh" }));
  await s.tick();
  assert.equal(bus.of("attention.focus")[0]!.reason, "engaged");
});

test("ticks don't overlap: a slow scorer is asked once", async () => {
  const { s, bus, calls, setGate } = setup();
  let release!: () => void;
  setGate(new Promise<void>((r) => (release = r)));
  await s.onEvent(chat("hey Coco?", { mentionsCohost: true }));
  const first = s.tick();
  await s.tick(); // skipped while the first is deciding
  release();
  await first;
  assert.equal(calls(), 1);
  assert.equal(bus.of("attention.focus").length, 1);
});

test("reflex: fires brain.say instantly and marks only its trigger seen", async () => {
  const { s, bus } = setup({ reflexes: [DIED] });
  await s.onEvent(chat("hello"));
  await s.onEvent(chat("lol you died"));
  const [say] = bus.of("brain.say");
  assert.deepEqual([say!.text, say!.emotion, say!.gesture, say!.reason], ["Oof.", "surprised", "facepalm", "reflex: you died"]);
  assert.deepEqual(s.ctx.unseen().map((e) => e.text), ["hello"]);
});

test("reflex: listens on speech, and on vision only when the screen changed", async () => {
  const { s, bus } = setup({ reflexes: [DIED] });
  await s.onEvent(event("vision.summary", { text: "YOU DIED", changed: false }));
  assert.equal(bus.of("brain.say").length, 0);
  await s.onEvent(event("vision.summary", { text: "YOU DIED", changed: true }));
  assert.equal(bus.of("brain.say").length, 1);
  const sp = setup({ reflexes: [DIED] });
  await sp.s.onEvent(event("speech.heard", { speaker: "Chris", text: "aaand you died", durationMs: 800 }));
  assert.equal(sp.bus.of("brain.say").length, 1);
});

test("reflex: never talks over the cortex, inside the cooldown, or while muted", async () => {
  const busy = setup({ reflexes: [DIED] });
  await busy.s.onEvent(event("brain.status", { state: "thinking" }));
  await busy.s.onEvent(chat("you died"));
  assert.equal(busy.bus.of("brain.say").length, 0);
  await busy.s.onEvent(idle);
  await busy.s.onEvent(chat("you died"));
  assert.equal(busy.bus.of("brain.say").length, 1);

  const cooling = setup({ cooldown_ms: 60_000, reflexes: [DIED] });
  await cooling.s.onEvent(event("brain.say", { id: "x", text: "hi", emotion: "happy" }));
  await cooling.s.onEvent(idle);
  await cooling.s.onEvent(chat("you died"));
  assert.equal(cooling.bus.of("brain.say").length, 0);

  const muted = setup({ reflexes: [DIED] });
  await muted.s.onEvent(event("control", { cmd: "mute" }));
  await muted.s.onEvent(chat("you died"));
  assert.equal(muted.bus.of("brain.say").length, 0);
});
