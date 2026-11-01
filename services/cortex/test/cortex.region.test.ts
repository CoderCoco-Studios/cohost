import { test } from "node:test";
import assert from "node:assert/strict";
import { ModuleSchema } from "@cohost/config";
import { Module } from "@cohost/modules";
import type { ChatMessage, ChatProvider } from "@cohost/llm";
import { FakeBus, event, recordingLog, silentLog, testConfig, waitFor } from "@cohost/testing";
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
const critic = (rules: (i: CriticInput) => CriticOutput = () => ({ ok: true })) =>
  new Module<CriticInput, CriticOutput>("critic", ModuleSchema.parse({}), {} as never, { rules }, silentLog);

function setup(opts: { cfg?: Record<string, unknown>; critic?: (i: CriticInput) => CriticOutput; personality?: () => string } = {}) {
  // recall_k 0 by default: most tests aren't about memory, and this skips the bus round-trip.
  const cfg = testConfig({ brain: { memory: { recall_k: 0 }, cortex: { recall_timeout_ms: 100 } }, ...opts.cfg });
  const bus = new FakeBus();
  const llm = new FakeLlm();
  const rec = recordingLog();
  const cortex = new Cortex({ cfg, bus, llm, critic: critic(opts.critic), log: rec.log, loadPersonality: opts.personality ?? (() => "You are Coco.") });
  return { cfg, bus, llm, cortex, rec, statuses: () => bus.of("brain.status").map((s) => s.state) };
}
const mention = (who = "bob", text = "hey Coco, how are you?") =>
  ({ reason: "mentioned", score: 1, focus: { kind: "chat" as const, who, text, mention: true } });

// @spec CTX-EVT-002, CTX-SAY-001, CTX-SAY-002
test("think: status thinking → LLM → brain.say with the parsed emotion and gesture → status speaking", async () => {
  const { cortex, bus, llm, statuses } = setup();
  llm.reply = () => "[laugh] [gesture:wave] hi bob!";
  await cortex.onEvent(event("chat.message", { platform: "twitch", user: "bob", text: "hey Coco", isMod: false, isSub: false, mentionsCohost: true }));
  await cortex.think(mention());
  const [say] = bus.of("brain.say");
  assert.deepEqual({ ...say, id: "x" }, { id: "x", text: "hi bob!", emotion: "laugh", gesture: "wave", reason: "mentioned" });
  assert.deepEqual(statuses(), ["thinking", "speaking"]);
  assert.match(llm.calls[0]![1]!.content, /\[chat\] bob: hey Coco/);
  assert.equal(bus.of("brain.status").at(-1)!.detail, "hi bob!");
});

// @spec CTX-RECALL-001, CTX-RECALL-005
test("recall: asks the memory region over the bus and puts the reply in the prompt", async () => {
  const { cortex, bus, llm } = setup({ cfg: { brain: { memory: { recall_k: 4 }, cortex: { recall_timeout_ms: 2000 } } } });
  const thinking = cortex.think(mention("bob", "remember my speedrun?"));
  await waitFor(() => bus.of("memory.recall.request").length === 1, "recall request");
  const req = bus.of("memory.recall.request")[0]!;
  assert.equal(req.query, "remember my speedrun?");
  assert.equal(req.k, 4);
  assert.equal(llm.calls.length, 0, "the LLM waits for memory");
  await cortex.onEvent(event("memory.recall.reply", { id: "someone-else", memories: [] })); // not ours: ignored
  await cortex.onEvent(event("memory.recall.reply", { id: req.id, memories: [{ ts: Date.UTC(2026, 0, 5), kind: "chat", who: "bob", text: "did a 12 minute run" }] }));
  await thinking;
  assert.match(llm.system, /- \(2026-01-05\) bob: did a 12 minute run/);
});

// @spec CTX-RECALL-001
test("recall: no focus text falls back to what's on screen; nothing at all skips recall", async () => {
  const { cortex, bus } = setup({ cfg: { brain: { memory: { recall_k: 4 } } } });
  await cortex.think({ reason: "idle chatter", score: 0 });
  assert.equal(bus.of("memory.recall.request").length, 0);
  await cortex.onEvent(event("voice.done", { id: bus.of("brain.say")[0]!.id, sink: "x" }));
  await cortex.onEvent(event("vision.summary", { text: "a boss fight", changed: true }));
  const t = cortex.think({ reason: "idle chatter", score: 0 });
  await waitFor(() => bus.of("memory.recall.request").length === 1);
  assert.equal(bus.of("memory.recall.request")[0]!.query, "a boss fight");
  await t; // times out (100 ms) and answers anyway
});

// @spec CTX-RECALL-003
test("recall: a silent memory region costs the timeout, not the reply", async () => {
  const { cortex, bus, llm, rec } = setup({ cfg: { brain: { memory: { recall_k: 4 }, cortex: { recall_timeout_ms: 50 } } } });
  const t0 = Date.now();
  await cortex.think(mention());
  assert.ok(Date.now() - t0 >= 45);
  assert.equal(llm.calls.length, 1);
  assert.equal(bus.of("brain.say").length, 1);
  assert.deepEqual(rec.msgs("warn"), ["memory region did not answer in time"]);
});

// @spec CTX-RECALL-004
test("recall: a failed publish answers immediately without memories", async () => {
  const { cortex, bus, llm } = setup({ cfg: { brain: { memory: { recall_k: 4 }, cortex: { recall_timeout_ms: 5000 } } } });
  bus.fail = (t) => t === "memory.recall.request";
  const t0 = Date.now();
  await cortex.think(mention());
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(llm.calls.length, 1);
});

// @spec CTX-EVT-006
test("attention.focus doesn't block the event loop, so the recall reply can arrive", async () => {
  const { cortex, bus } = setup({ cfg: { brain: { memory: { recall_k: 4 }, cortex: { recall_timeout_ms: 2000 } } } });
  await cortex.onEvent(event("attention.focus", mention())); // returns before thinking finishes
  await waitFor(() => bus.of("memory.recall.request").length === 1);
  await cortex.onEvent(event("memory.recall.reply", { id: bus.of("memory.recall.request")[0]!.id, memories: [] }));
  await waitFor(() => bus.of("brain.say").length === 1, "the reply");
});

// @spec CTX-GATE-001, CTX-GATE-007
test("only one thought at a time: a second focus while thinking just re-reports thinking", async () => {
  const { cortex, bus, llm, statuses } = setup();
  let release!: () => void;
  llm.reply = () => new Promise((r) => { release = () => r("[happy] done"); });
  const first = cortex.think(mention());
  await waitFor(() => llm.calls.length === 1);
  await cortex.think({ reason: "engaged", score: 1 });
  assert.equal(llm.calls.length, 1);
  release();
  await first;
  llm.reply = () => "[happy] again";
  assert.deepEqual(statuses(), ["thinking", "thinking", "speaking"]);
  assert.equal(bus.of("brain.status")[1]!.detail, "engaged");
  await cortex.onEvent(event("voice.done", { id: bus.of("brain.say")[0]!.id, sink: "x" }));
  await cortex.think(mention()); // and it's free again afterwards
  assert.equal(llm.calls.length, 2);
});

// @spec CTX-GATE-002, CTX-CTRL-003
test("muted: no LLM call, status muted; unmute resumes", async () => {
  const { cortex, llm, statuses } = setup();
  await cortex.onEvent(event("control", { cmd: "mute" }));
  await cortex.think(mention());
  assert.equal(llm.calls.length, 0);
  assert.deepEqual(statuses(), ["muted", "muted"]);
  await cortex.onEvent(event("control", { cmd: "unmute" }));
  await cortex.think(mention());
  assert.equal(llm.calls.length, 1);
});

// @spec CTX-EVT-004, CTX-EVT-005, CTX-GATE-003
test("someone else's line (reflex/operator) holds the cortex until its voice.done", async () => {
  const { cortex, llm, statuses } = setup();
  await cortex.onEvent(event("brain.say", { id: "reflex-1", text: "Oof.", emotion: "surprised", reason: "reflex: died" }, "salience"));
  await cortex.think(mention());
  assert.equal(llm.calls.length, 0);
  assert.deepEqual(statuses(), ["speaking"]);
  await cortex.onEvent(event("voice.done", { id: "other", sink: "x" }));
  assert.deepEqual(statuses(), ["speaking"]);
  await cortex.onEvent(event("voice.done", { id: "reflex-1", sink: "x" }));
  assert.deepEqual(statuses(), ["speaking", "idle"]);
  await cortex.think(mention());
  assert.equal(llm.calls.length, 1);
});

// @spec CTX-EVT-003, CTX-EVT-004
test("its own brain.say lands in the transcript but doesn't hold itself", async () => {
  const { cortex, llm } = setup();
  await cortex.onEvent(event("brain.say", { id: "mine", text: "earlier line", emotion: "smug" }, "cortex"));
  await cortex.think(mention());
  assert.equal(llm.calls.length, 1);
  assert.match(llm.calls[0]![1]!.content, /Coco: \[smug\] earlier line/);
});

// @spec CTX-GATE-004
test("a stuck voice sink is ignored after speaking_timeout_ms", async () => {
  const { cortex, llm } = setup({ cfg: { brain: { memory: { recall_k: 0 }, cortex: { speaking_timeout_ms: 30 } } } });
  await cortex.onEvent(event("brain.say", { id: "stuck", text: "x", emotion: "neutral" }, "operator"));
  await cortex.think(mention());
  assert.equal(llm.calls.length, 0);
  await new Promise((r) => setTimeout(r, 40));
  await cortex.think(mention());
  assert.equal(llm.calls.length, 1);
});

// @spec CTX-GATE-003, CTX-SAY-004
test("while it waits on voice.done for its own line, it doesn't start another", async () => {
  const { cortex, bus, llm } = setup();
  await cortex.think(mention());
  await cortex.think(mention());
  assert.equal(llm.calls.length, 1);
  await cortex.onEvent(event("voice.done", { id: bus.of("brain.say")[0]!.id, sink: "virtual" }));
  await cortex.think(mention());
  assert.equal(llm.calls.length, 2);
});

// @spec CTX-GATE-006
test("a line that started while thinking wins: the cortex's reply is dropped", async () => {
  const { cortex, bus, llm, statuses } = setup();
  llm.reply = async () => {
    await cortex.onEvent(event("brain.say", { id: "op", text: "operator line", emotion: "neutral" }, "dashboard"));
    return "[happy] my reply";
  };
  await cortex.think(mention());
  assert.equal(bus.of("brain.say").length, 0);
  assert.deepEqual(statuses(), ["thinking", "speaking"]);
});

// @spec CTX-GATE-005
test("muted while thinking: the reply is dropped", async () => {
  const { cortex, bus, llm, statuses } = setup();
  llm.reply = async () => { await cortex.onEvent(event("control", { cmd: "mute" })); return "[happy] my reply"; };
  await cortex.think(mention());
  assert.equal(bus.of("brain.say").length, 0);
  assert.deepEqual(statuses(), ["thinking", "muted", "muted"]);
});

// @spec CTX-PROMPT-006
test("an empty or one-character reply says nothing and goes idle", async () => {
  for (const reply of ["", "[happy]", "[happy] k"]) {
    const { cortex, bus, llm, statuses } = setup();
    llm.reply = () => reply;
    await cortex.think(mention());
    assert.equal(bus.of("brain.say").length, 0, reply);
    assert.deepEqual(statuses(), ["thinking", "idle"]);
  }
});

// @spec CTX-SAY-003, CTX-GATE-007
test("an LLM error goes idle and frees the cortex", async () => {
  const { cortex, llm, statuses, rec } = setup();
  llm.reply = () => { throw new Error("backend down"); };
  await cortex.think(mention());
  assert.deepEqual(statuses(), ["thinking", "idle"]);
  assert.deepEqual(rec.msgs("error"), ["think failed"]);
  llm.reply = () => "[happy] back";
  await cortex.think(mention());
  assert.equal(llm.calls.length, 2);
});

// @spec CTX-CRITIC-001, CTX-CRITIC-002, CTX-CRITIC-003
test("critic: sees the line and transcript; can veto, rewrite and re-emote", async () => {
  let seen: CriticInput | undefined;
  const veto = setup({ critic: (i) => { seen = i; return { ok: false, note: "too long" }; } });
  await veto.cortex.onEvent(event("chat.message", { platform: "twitch", user: "bob", text: "hi", isMod: false, isSub: false, mentionsCohost: true }));
  await veto.cortex.think(mention());
  assert.deepEqual(seen, { text: "hey chat!", emotion: "happy", reason: "mentioned", transcript: "[chat] bob: hi" });
  assert.equal(veto.bus.of("brain.say").length, 0);
  assert.deepEqual(veto.statuses(), ["thinking", "idle"]);

  const edit = setup({ critic: () => ({ ok: true, text: "hey!", emotion: "smug" }) });
  await edit.cortex.think(mention());
  const [say] = edit.bus.of("brain.say");
  assert.equal(say!.text, "hey!");
  assert.equal(say!.emotion, "smug");
});

// @spec CTX-VIEWER-001, CTX-VIEWER-003
test("viewer notes: new and regular viewers are introduced once, to that viewer's reply only", async () => {
  const { cortex, bus, llm } = setup();
  const done = async () => cortex.onEvent(event("voice.done", { id: bus.of("brain.say").at(-1)!.id, sink: "x" }));
  await cortex.onEvent(event("memory.viewer", { user: "Bob", isNew: true, msgCount: 1 }));
  await cortex.onEvent(event("memory.viewer", { user: "amy", isNew: false, msgCount: 40, notes: "loves cats" }));
  await cortex.onEvent(event("memory.viewer", { user: "cat", isNew: false, msgCount: 10 }));

  await cortex.think(mention("amy"));
  assert.match(llm.system, /- amy is a regular \(40 messages\)\. Notes: loves cats/);
  assert.doesNotMatch(llm.system, /Bob is new/);
  await done();
  await cortex.think(mention("bob")); // case-insensitive
  assert.match(llm.system, /- Bob is new here \(first message\)\./);
  await done();
  await cortex.think(mention("bob")); // consumed
  assert.doesNotMatch(llm.system, /is new here/);
  await done();
  await cortex.think(mention("cat")); // neither new nor a regular: no note
  assert.doesNotMatch(llm.system, /cat is/);
});

// @spec CTX-VIEWER-002
test("a later viewer update replaces (or clears) the earlier note", async () => {
  const { cortex, llm } = setup();
  await cortex.onEvent(event("memory.viewer", { user: "bob", isNew: true, msgCount: 1 }));
  await cortex.onEvent(event("memory.viewer", { user: "bob", isNew: false, msgCount: 2 }));
  await cortex.think(mention("bob"));
  assert.doesNotMatch(llm.system, /bob is/);
});

// @spec CTX-EVT-007
test("affect.state colours the prompt", async () => {
  const { cortex, llm } = setup();
  await cortex.onEvent(event("affect.state", { valence: 0.6, arousal: 0.7, mood: "laugh" }));
  await cortex.think(mention());
  assert.match(llm.system, /current mood: in a great mood, buzzing \(laugh\)/);
});

// @spec CTX-CTRL-004, CTX-CTRL-005, CTX-CTRL-006
test("control: say speaks as the operator; forget_context clears the window and notes; reload_personality re-reads the file", async () => {
  let personality = "You are Coco v1.";
  const { cortex, bus, llm } = setup({ personality: () => personality });
  await cortex.onEvent(event("control", { cmd: "say", text: "brb" }));
  const [op] = bus.of("brain.say");
  assert.deepEqual([op!.text, op!.emotion, op!.gesture, op!.reason], ["brb", "neutral", undefined, "operator"]);
  await cortex.onEvent(event("voice.done", { id: bus.of("brain.say")[0]!.id, sink: "x" }));
  await cortex.onEvent(event("control", { cmd: "say" })); // no text: nothing to say
  assert.equal(bus.of("brain.say").length, 1);

  await cortex.onEvent(event("chat.message", { platform: "twitch", user: "bob", text: "old news", isMod: false, isSub: false, mentionsCohost: false }));
  await cortex.onEvent(event("memory.viewer", { user: "bob", isNew: true, msgCount: 1 }));
  await cortex.onEvent(event("control", { cmd: "forget_context" }));
  personality = "You are Coco v2.";
  await cortex.onEvent(event("control", { cmd: "reload_personality" }));
  await cortex.think(mention("bob"));
  assert.ok(llm.system.startsWith("You are Coco v2."));
  assert.doesNotMatch(llm.system, /bob is new/);
  assert.doesNotMatch(llm.calls[0]![1]!.content, /old news/);
});

// @spec CTX-CTRL-001, CTX-CTRL-002, CTX-GATE-002
test("pause: no LLM call, status muted; resume restores; a pause for another service is ignored", async () => {
  const { cortex, llm, bus, statuses } = setup();
  await cortex.onEvent(event("control", { cmd: "pause", target: "voice" }));
  assert.deepEqual(statuses(), []);

  await cortex.onEvent(event("control", { cmd: "pause", target: "cortex" }));
  await cortex.think(mention());
  assert.equal(llm.calls.length, 0, "no LLM call while paused");
  assert.deepEqual(statuses(), ["muted", "muted"]);

  await cortex.onEvent(event("control", { cmd: "resume" }));
  bus.clear();
  await cortex.think(mention());
  assert.equal(llm.calls.length, 1);
});

// @spec CTX-CTRL-001
test("a targeted mute for another service does not mute the cortex", async () => {
  const { cortex, llm } = setup();
  await cortex.onEvent(event("control", { cmd: "mute", target: "salience" }));
  await cortex.think(mention());
  assert.equal(llm.calls.length, 1);
});

// ---- test injection

// @spec CTX-INJ-001
test("think: a reply to an injected focus carries injected/remember; remembered stays remembered", async () => {
  const a = setup();
  await a.cortex.think({ ...mention(), injected: true, remember: false });
  assert.equal(a.bus.of("brain.say")[0]!.injected, true);
  assert.equal(a.bus.of("brain.say")[0]!.remember, false);
  const b = setup();
  await b.cortex.think({ ...mention(), injected: true, remember: true });
  assert.equal(b.bus.of("brain.say")[0]!.remember, true);
});

// @spec CTX-INJ-002
test("think: a real focus, and control say, produce unflagged brain.say", async () => {
  const { cortex, bus } = setup();
  await cortex.think({ ...mention(), remember: true });
  await cortex.onEvent(event("control", { cmd: "say", text: "brb" }));
  const says = bus.of("brain.say");
  assert.equal(says.length, 2);
  for (const s of says) assert.equal("injected" in s || "remember" in s, false);
});
