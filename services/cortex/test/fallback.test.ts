import { test } from "node:test";
import assert from "node:assert/strict";
import { ModuleSchema } from "@cohost/config";
import { Module } from "@cohost/modules";
import type { ChatMessage, ChatProvider } from "@cohost/llm";
import { FakeBus, event, silentLog, testConfig } from "@cohost/testing";
import { Cortex } from "../src/cortex.js";
import type { CriticInput, CriticOutput } from "../src/critic.js";

class FakeLlm implements ChatProvider {
  readonly name = "fake";
  readonly model = "fake";
  calls: ChatMessage[][] = [];
  reply: () => string | Promise<string> = () => "[happy] hey chat!";
  async chat(msgs: ChatMessage[]) { this.calls.push(msgs); return this.reply(); }
  async ping() { return true; }
  system(i = -1) { return this.calls.at(i)![0]!.content; }
  user(i = -1) { return this.calls.at(i)![1]!.content; }
}

function setup(opts: { chance?: number; critic?: (i: CriticInput) => CriticOutput } = {}) {
  const cfg = testConfig({
    brain: { memory: { recall_k: 0 }, cortex: { recall_timeout_ms: 100, ...(opts.chance !== undefined ? { fallback_ack_chance: opts.chance } : {}) } },
  });
  const bus = new FakeBus();
  const llm = new FakeLlm();
  const critic = new Module<CriticInput, CriticOutput>("critic", ModuleSchema.parse({}), {} as never, { rules: opts.critic ?? (() => ({ ok: true })) }, silentLog);
  const cortex = new Cortex({ cfg, bus, llm, critic, log: silentLog, loadPersonality: () => "You are Coco." });
  return { cfg, bus, llm, cortex };
}
const mention = () => ({ reason: "mentioned", score: 1, focus: { kind: "chat" as const, who: "bob", text: "hey Coco", mention: true } });
const FALLBACK = { clip: "c1", text: "my mic died" };
const failed = (id: string, fallback: { clip: string; text: string } | null = FALLBACK) =>
  event("voice.failed", { id, sink: "discord", reason: "tts down", ...(fallback ? { fallback } : {}) });
const doneFor = (cortex: Cortex, id: string) => cortex.onEvent(event("voice.done", { id, sink: "x" }));

/** Cortex says one line and it plays out; returns that line's brain.say id. */
async function sayOne(s: ReturnType<typeof setup>, text = "[happy] intended line"): Promise<string> {
  s.llm.reply = () => text;
  await s.cortex.think(mention());
  const say = s.bus.of("brain.say").at(-1)!;
  await s.cortex.onEvent(event("brain.say", say, "cortex"));
  await doneFor(s.cortex, say.id);
  return say.id;
}
const HINT = /Your voice glitched/;

// @spec CTX-FALL-001
test("every brain.say, from any source, goes into working memory with its id", async () => {
  const { cortex } = setup();
  await cortex.onEvent(event("brain.say", { id: "r1", text: "reflex line", emotion: "happy", reason: "reflex" }, "salience"));
  await cortex.onEvent(event("brain.say", { id: "c1", text: "cortex line", emotion: "neutral", reason: "x" }, "cortex"));
  const selfs = cortex.ctx.all().filter((e) => e.kind === "self") as { id?: string; text: string }[];
  assert.deepEqual(selfs.map((e) => [e.id, e.text]), [["r1", "reflex line"], ["c1", "cortex line"]]);
});

// @spec CTX-FALL-002
test("voice.failed with a fallback marks that line in the transcript (any source), and later prompts show the note", async () => {
  const s = setup();
  await s.cortex.onEvent(event("brain.say", { id: "r1", text: "reflex line", emotion: "happy", reason: "reflex" }, "salience"));
  await s.cortex.onEvent(failed("r1"));
  assert.match(s.cortex.ctx.transcript("Coco"), /Coco: \[happy\] my mic died \[your line "reflex line" failed to play; this came out instead\]/);
  await doneFor(s.cortex, "r1");
  await s.cortex.think(mention());
  assert.match(s.llm.user(), /failed to play; this came out instead/);
});

// @spec CTX-FALL-002
test("voice.failed for an id not in the window changes nothing", async () => {
  const s = setup();
  await s.cortex.onEvent(event("brain.say", { id: "a", text: "x line", emotion: "happy", reason: "r" }, "salience"));
  await s.cortex.onEvent(failed("zzz"));
  assert.doesNotMatch(s.cortex.ctx.transcript("Coco"), /failed to play/);
});

// @spec CTX-FALL-003, CTX-FALL-004
test("a fallback sets a pending glitch: the next think's system message carries one hint line quoting both texts and 25%", async () => {
  const s = setup();
  const id = await sayOne(s);
  await s.cortex.onEvent(failed(id));
  await s.cortex.think(mention());
  const sys = s.llm.system();
  assert.equal(sys.split("\n").filter((l) => HINT.test(l)).length, 1);
  assert.match(sys, /your line "intended line" failed to play and everyone heard "my mic died" instead/);
  assert.match(sys, /about 25% of the time/);
  assert.match(sys.split("\n").find((l) => HINT.test(l))!, /^- /);
  assert.ok(sys.indexOf("Your voice glitched") < sys.indexOf("## Output"));
});

// @spec CTX-FALL-004
test("the percentage follows the configured base chance, rounded", async () => {
  const s = setup({ chance: 0.5 });
  await s.cortex.onEvent(event("brain.say", { id: "a", text: "x line", emotion: "happy", reason: "r" }, "salience"));
  await s.cortex.onEvent(failed("a"));
  await doneFor(s.cortex, "a");
  await s.cortex.think(mention());
  assert.match(s.llm.system(), /about 50% of the time/);
});

// @spec CTX-FALL-003
test("a newer glitch replaces an older pending one", async () => {
  const s = setup();
  await s.cortex.onEvent(event("brain.say", { id: "a", text: "first line", emotion: "happy", reason: "r" }, "salience"));
  await s.cortex.onEvent(failed("a", { clip: "c1", text: "fallback one" }));
  await doneFor(s.cortex, "a");
  await s.cortex.onEvent(event("brain.say", { id: "b", text: "second line", emotion: "happy", reason: "r" }, "salience"));
  await s.cortex.onEvent(failed("b", { clip: "c2", text: "fallback two" }));
  await doneFor(s.cortex, "b");
  await s.cortex.think(mention());
  assert.match(s.llm.system(), /"second line" failed to play and everyone heard "fallback two"/);
  assert.doesNotMatch(s.llm.system(), /first line/);
});

// @spec CTX-FALL-005
test("the glitch is consumed once the reply that carried its hint is published", async () => {
  const s = setup();
  const id = await sayOne(s);
  await s.cortex.onEvent(failed(id));
  await s.cortex.think(mention());
  assert.match(s.llm.system(), HINT);
  const second = s.bus.of("brain.say").at(-1)!;
  await s.cortex.onEvent(event("brain.say", second, "cortex"));
  await doneFor(s.cortex, second.id);
  await s.cortex.think(mention());
  assert.doesNotMatch(s.llm.system(), HINT);
});

// @spec CTX-FALL-005
test("a vetoed, empty or failed reply keeps the glitch for the next think", async () => {
  const s = setup({ critic: (i) => (i.text.includes("veto") ? { ok: false, note: "no" } : { ok: true }) });
  const id = await sayOne(s);
  await s.cortex.onEvent(failed(id));
  s.llm.reply = () => "[happy] veto me";
  await s.cortex.think(mention());
  s.llm.reply = () => "";
  await s.cortex.think(mention());
  s.llm.reply = () => { throw new Error("llm down"); };
  await s.cortex.think(mention());
  s.llm.reply = () => "[happy] fine";
  await s.cortex.think(mention());
  assert.equal(s.llm.calls.length, 5);
  for (const i of [1, 2, 3, 4]) assert.match(s.llm.system(i), HINT, `think ${i} still carries the hint`);
  assert.equal(s.bus.of("brain.say").length, 2);
});

// @spec CTX-FALL-005
test("a newer glitch that arrived during a think survives that think's publish", async () => {
  const s = setup();
  const id = await sayOne(s);
  await s.cortex.onEvent(failed(id));
  s.llm.reply = async () => {
    await s.cortex.onEvent(event("brain.say", { id: "n", text: "newer line", emotion: "happy", reason: "r" }, "salience"));
    await s.cortex.onEvent(failed("n", { clip: "c2", text: "newer fallback" }));
    await doneFor(s.cortex, "n");
    return "[happy] reply";
  };
  await s.cortex.think(mention());
  await doneFor(s.cortex, s.bus.of("brain.say").at(-1)!.id);
  s.llm.reply = () => "[happy] again";
  await s.cortex.think(mention());
  assert.match(s.llm.system(), /"newer line" failed to play and everyone heard "newer fallback"/);
});

// @spec CTX-FALL-005
test("forget_context drops the glitch", async () => {
  const s = setup();
  const id = await sayOne(s);
  await s.cortex.onEvent(failed(id));
  await s.cortex.onEvent(event("control", { cmd: "forget_context" }));
  await s.cortex.think(mention());
  assert.doesNotMatch(s.llm.system(), HINT);
});

// @spec CTX-FALL-005
test("a glitch whose line has left the window is dropped, and stays dropped", async () => {
  const s = setup();
  const cap = s.cfg.brain.working_memory_events;
  await s.cortex.onEvent(event("brain.say", { id: "a", text: "old line", emotion: "happy", reason: "r" }, "salience"));
  await s.cortex.onEvent(failed("a"));
  await doneFor(s.cortex, "a");
  for (let i = 0; i < cap; i++) await s.cortex.onEvent(event("chat.message", { platform: "twitch", user: "u", text: `m${i}`, isMod: false, isSub: false, mentionsCohost: false }));
  await s.cortex.think(mention());
  assert.doesNotMatch(s.llm.system(), HINT);
});

// @spec CTX-FALL-004
test("with a base chance of 0 there is no hint line, but the transcript note stays and the glitch is not consumed", async () => {
  const s = setup({ chance: 0 });
  const id = await sayOne(s);
  await s.cortex.onEvent(failed(id));
  await s.cortex.think(mention());
  assert.doesNotMatch(s.llm.system(), HINT);
  assert.match(s.llm.user(), /failed to play; this came out instead/);
});

// @spec CTX-FALL-006
test("nothing draws a random number or checks the reply against the chance: the hint is always present and any reply is published", async () => {
  const realRandom = Math.random;
  let draws = 0;
  Math.random = () => { draws++; return realRandom(); };
  try {
    for (const reply of ["[happy] riffing on the glitch lol", "[happy] unrelated line entirely"]) {
      const s = setup();
      const id = await sayOne(s);
      await s.cortex.onEvent(failed(id));
      s.llm.reply = () => reply;
      await s.cortex.think(mention());
      assert.match(s.llm.system(), HINT);
      assert.equal(s.bus.of("brain.say").length, 2);
    }
  } finally { Math.random = realRandom; }
  assert.equal(draws, 0);
});

// @spec CTX-FALL-007
test("voice.failed without a fallback changes neither working memory, the pending glitch nor the speaking state", async () => {
  const s = setup();
  const id = await sayOne(s);
  await s.cortex.onEvent(failed(id));
  const before = JSON.stringify(s.cortex.ctx.all());
  // a second line, still playing, fails without a fallback
  await s.cortex.onEvent(event("brain.say", { id: "p", text: "playing line", emotion: "happy", reason: "r" }, "salience"));
  const mid = JSON.stringify(s.cortex.ctx.all());
  await s.cortex.onEvent(failed("p", null));
  assert.equal(JSON.stringify(s.cortex.ctx.all()), mid);
  assert.notEqual(before, mid);
  // still speaking: a think reports speaking and does not call the model
  const calls = s.llm.calls.length;
  await s.cortex.think(mention());
  assert.equal(s.llm.calls.length, calls);
  await doneFor(s.cortex, "p");
  await s.cortex.think(mention());
  assert.match(s.llm.system(), HINT); // glitch from the earlier line still pending
});
