import { test } from "node:test";
import assert from "node:assert/strict";
import { ModuleSchema } from "@cohost/config";
import { Module } from "@cohost/modules";
import type { ChatMessage, ChatProvider } from "@cohost/llm";
import type { BusEvent, EventInput, EventType } from "@cohost/bus";
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

type NotesViewers = BusEvent<"memory.notes.reply">["data"]["viewers"];
type NotesRequest = BusEvent<"memory.notes.request">["data"];

/** A bus that hands each `memory.notes.request` to `onNotes`, standing in for the memory region. */
class NotesBus extends FakeBus {
  onNotes: (req: NotesRequest) => void = () => {};
  override async publish<T extends EventType>(type: T, data: EventInput<T>): Promise<string> {
    const id = await super.publish(type, data);
    if (type === "memory.notes.request") queueMicrotask(() => this.onNotes(data as NotesRequest));
    return id;
  }
}

function setup(opts: {
  cfg?: Record<string, unknown>; critic?: (i: CriticInput) => CriticOutput; personality?: () => string;
  /** What memory answers to a notes request: viewers to reply with, or undefined for silence. Default: an empty list. */
  notes?: (req: NotesRequest) => NotesViewers | undefined;
} = {}) {
  // recall_k 0 by default: most tests aren't about memory, and this skips the bus round-trip.
  const cfg = testConfig({ brain: { memory: { recall_k: 0 }, cortex: { recall_timeout_ms: 100 } }, ...opts.cfg });
  const bus = new NotesBus();
  const llm = new FakeLlm();
  const rec = recordingLog();
  const cortex = new Cortex({ cfg, bus, llm, critic: critic(opts.critic), log: rec.log, loadPersonality: opts.personality ?? (() => "You are Coco.") });
  bus.onNotes = (req) => {
    const viewers = (opts.notes ?? (() => []))(req);
    if (viewers) void cortex.onEvent(event("memory.notes.reply", { id: req.id, viewers }));
  };
  return { cfg, bus, llm, cortex, rec, statuses: () => bus.of("brain.status").map((s) => s.state) };
}
const say = (user: string, text = "hi") =>
  event("chat.message", { platform: "twitch", user, text, isMod: false, isSub: false, mentionsCohost: false });
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
  await cortex.onEvent(event("memory.viewer", { user: "Bob", isNew: true, msgCount: 1, regular: false }));
  await cortex.onEvent(event("memory.viewer", { user: "amy", isNew: false, msgCount: 40, regular: true }));
  await cortex.onEvent(event("memory.viewer", { user: "cat", isNew: false, msgCount: 10, regular: false }));
  await cortex.onEvent(event("memory.viewer", { user: "flo", isNew: false, msgCount: 3, regular: true })); // the owner's flag, below any threshold

  await cortex.think(mention("amy"));
  assert.match(llm.system, /- amy is a regular \(40 messages\)\.\n/);
  assert.doesNotMatch(llm.system, /Notes:/, "no notes text rides on memory.viewer");
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
  await done();
  await cortex.think(mention("flo")); // regular status is memory's call, not a message count here
  assert.match(llm.system, /- flo is a regular \(3 messages\)\./);
});

// @spec CTX-VIEWER-001
test("a viewer who is both new and regular gets the new-here line", async () => {
  const { cortex, llm } = setup();
  await cortex.onEvent(event("memory.viewer", { user: "zed", isNew: true, msgCount: 1, regular: true }));
  await cortex.think(mention("zed"));
  assert.match(llm.system, /zed is new here/);
  assert.doesNotMatch(llm.system, /zed is a regular/);
});

// @spec CTX-VIEWER-002
test("a later viewer update replaces (or clears) the earlier note", async () => {
  const { cortex, llm } = setup();
  await cortex.onEvent(event("memory.viewer", { user: "bob", isNew: true, msgCount: 1, regular: false }));
  await cortex.onEvent(event("memory.viewer", { user: "bob", isNew: false, msgCount: 2, regular: false }));
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
  await cortex.onEvent(event("memory.viewer", { user: "bob", isNew: true, msgCount: 1, regular: false }));
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

// @spec CTX-GATE-008
test("a failed brain.status publish on a gated early return is logged, not raised", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => { unhandled.push(e); };
  process.on("unhandledRejection", onUnhandled);
  try {
    for (const gate of ["muted", "paused", "speaking"] as const) {
      const { cortex, bus, llm, rec } = setup();
      if (gate === "muted") await cortex.onEvent(event("control", { cmd: "mute" }));
      if (gate === "paused") await cortex.onEvent(event("control", { cmd: "pause" }));
      if (gate === "speaking") await cortex.onEvent(event("brain.say", { id: "op", text: "x", emotion: "neutral" }, "operator"));
      bus.fail = (t) => t === "brain.status";
      await cortex.think(mention()); // resolves; does not reject
      await cortex.onEvent(event("attention.focus", mention())); // the unawaited path
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(llm.calls.length, 0, gate);
      assert.ok(rec.msgs("error").length >= 2, `${gate}: failures are logged`);
    }
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

// @spec CTX-GATE-009
test("speaking_timeout_ms with no voice.done releases the status: idle, or muted when muted or paused", async () => {
  const cfg = { brain: { memory: { recall_k: 0 }, cortex: { speaking_timeout_ms: 30 } } };
  const a = setup({ cfg });
  await a.cortex.onEvent(event("brain.say", { id: "stuck", text: "x", emotion: "neutral" }, "operator"));
  assert.deepEqual(a.statuses(), []);
  await waitFor(() => a.statuses().length === 1, "timeout release");
  assert.deepEqual(a.statuses(), ["idle"]);

  const b = setup({ cfg });
  await b.cortex.onEvent(event("brain.say", { id: "stuck", text: "x", emotion: "neutral" }, "operator"));
  await b.cortex.onEvent(event("control", { cmd: "mute" }));
  await waitFor(() => b.statuses().length === 2, "timeout release while muted");
  assert.deepEqual(b.statuses(), ["muted", "muted"]);

  // voice.done in time cancels the release; so does the cortex's own line finishing.
  const c = setup({ cfg });
  await c.cortex.onEvent(event("brain.say", { id: "ok", text: "x", emotion: "neutral" }, "operator"));
  await c.cortex.onEvent(event("voice.done", { id: "ok", sink: "x" }));
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(c.statuses(), ["idle"]);
});

// @spec CTX-RECALL-001
test("recall: a focus with empty text falls back to the vision summary", async () => {
  const { cortex, bus } = setup({ cfg: { brain: { memory: { recall_k: 4 }, cortex: { recall_timeout_ms: 50 } } } });
  await cortex.onEvent(event("vision.summary", { text: "a boss fight", changed: true }));
  await cortex.think({ reason: "engaged", score: 1, focus: { kind: "chat", who: "bob", text: "", mention: false } });
  assert.equal(bus.of("memory.recall.request")[0]!.query, "a boss fight");
  const none = setup({ cfg: { brain: { memory: { recall_k: 4 }, cortex: { recall_timeout_ms: 50 } } } });
  await none.cortex.think({ reason: "engaged", score: 1, focus: { kind: "chat", who: "bob", text: "", mention: false } });
  assert.equal(none.bus.of("memory.recall.request").length, 0);
});

// @spec CTX-VIEWER-003
test("viewer note: kept when the reply is vetoed, dropped or fails; deleted once the say is published", async () => {
  const { cortex, bus, llm } = setup({ critic: (i) => (i.text === "veto me" ? { ok: false } : { ok: true }) });
  await cortex.onEvent(event("memory.viewer", { user: "bob", isNew: true, msgCount: 1, regular: false }));
  const note = /Bob is new here|bob is new here/i;

  llm.reply = () => "[happy] veto me"; // vetoed
  await cortex.think(mention("bob"));
  llm.reply = () => { throw new Error("down"); }; // fails
  await cortex.think(mention("bob"));
  llm.reply = async () => { await cortex.onEvent(event("brain.say", { id: "op", text: "x", emotion: "neutral" }, "dashboard")); return "[happy] hi"; }; // dropped
  await cortex.think(mention("bob"));
  assert.equal(bus.of("brain.say").length, 0);
  assert.equal(llm.calls.length, 3);
  for (const c of llm.calls) assert.match(c[0]!.content, note);

  await cortex.onEvent(event("voice.done", { id: "op", sink: "x" }));
  llm.reply = () => "[happy] hello bob";
  await cortex.think(mention("bob")); // spoken: note used and consumed
  assert.match(llm.calls[3]![0]!.content, note);
  assert.equal(bus.of("brain.say").length, 1);
  await cortex.onEvent(event("voice.done", { id: bus.of("brain.say")[0]!.id, sink: "x" }));
  await cortex.think(mention("bob"));
  assert.doesNotMatch(llm.calls[4]![0]!.content, note);
});

// @spec CTX-PROMPT-007
test("llm reply log: elapsed, reason and memory count at info; the raw text only at debug", async () => {
  const { cortex, rec } = setup();
  await cortex.think(mention());
  const info = rec.lines.find((l) => l.level === "info" && l.msg === "llm reply")!;
  assert.deepEqual(Object.keys(info.obj as object).sort(), ["memories", "ms", "reason"]);
  assert.equal((info.obj as { reason: string }).reason, "mentioned");
  const dbg = rec.lines.filter((l) => l.level === "debug");
  assert.ok(dbg.some((l) => (l.obj as { raw?: string }).raw === "[happy] hey chat!"));
  assert.ok(!rec.lines.some((l) => l.level !== "debug" && JSON.stringify(l.obj).includes("hey chat!")));
});

// @spec CTX-CTRL-004
test("forget_context also clears the last vision summary: no 'on screen' line, no recall fallback", async () => {
  const { cortex, bus, llm } = setup({ cfg: { brain: { memory: { recall_k: 4 }, cortex: { recall_timeout_ms: 20 } } } });
  await cortex.onEvent(event("vision.summary", { text: "a boss fight", changed: true }));
  await cortex.onEvent(event("control", { cmd: "forget_context" }));
  assert.equal(cortex.ctx.lastVision, "");
  await cortex.think({ reason: "idle chatter", score: 0 });
  assert.doesNotMatch(llm.system, /On screen right now/);
  assert.equal(bus.of("memory.recall.request").length, 0);
});

// ---- viewer notes from memory (CTX-NOTES-*) ----

const general = (text: string, strength = 0.8) => ({ layer: "recent" as const, category: "general" as const, text, strength });
const aliceNotes = (): NotesViewers => [{ user: "alice", regular: true, msgCount: 40, notes: [general("got a new puppy named Biscuit")] }];

// @spec CTX-NOTES-001
test("notes request: the replied-to viewer first, then the distinct chat users in the window, newest first, each once", async () => {
  const { cortex, bus } = setup();
  for (const [u, t] of [["amy", "a"], ["Bob", "b"], ["cat", "c"], ["AMY", "d"]] as const) await cortex.onEvent(say(u, t));
  await cortex.onEvent(event("speech.heard", { speaker: "Chris", text: "hello", durationMs: 100 })); // voice is not a viewer
  await cortex.think(mention("bob"));
  const [req] = bus.of("memory.notes.request");
  assert.deepEqual(req!.users, ["bob", "AMY", "cat"]);
  assert.ok(req!.id.length > 0);
});

// @spec CTX-NOTES-001
test("notes request: no focus who means the window users alone; an empty list skips the request; every think gets a fresh id", async () => {
  const none = setup();
  await none.cortex.think({ reason: "idle chatter", score: 0 });
  assert.equal(none.bus.of("memory.notes.request").length, 0, "nobody to ask about");

  const { cortex, bus } = setup();
  await cortex.onEvent(say("amy"));
  await cortex.think({ reason: "idle chatter", score: 0 });
  assert.deepEqual(bus.of("memory.notes.request")[0]!.users, ["amy"]);
  await cortex.onEvent(event("voice.done", { id: bus.of("brain.say")[0]!.id, sink: "x" }));
  await cortex.think(mention("amy"));
  const ids = bus.of("memory.notes.request").map((r) => r.id);
  assert.equal(new Set(ids).size, 2);
});

// @spec CTX-NOTES-001
test("notes request: a think that is gated off sends none", async () => {
  const { cortex, bus } = setup();
  await cortex.onEvent(event("control", { cmd: "mute" }));
  await cortex.think(mention("bob"));
  assert.equal(bus.of("memory.notes.request").length, 0);
});

// @spec CTX-NOTES-001, CTX-NOTES-004, CTX-NOTES-007
test("notes are shown for any viewer, regular or not, replied-to or just in the window", async () => {
  const { cortex, llm } = setup({
    notes: () => [
      { user: "bob", regular: false, msgCount: 2, notes: [general("new to the Minecraft server")] },
      { user: "amy", regular: true, msgCount: 60, notes: [general("speedruns Celeste")] },
    ],
  });
  await cortex.onEvent(say("amy"));
  await cortex.think(mention("bob"));
  assert.match(llm.system, /## People here\n- bob: new to the Minecraft server\n- amy: speedruns Celeste\n/);
});

// @spec CTX-NOTES-002
test("recall and notes requests go out together and the think waits for both", async () => {
  const { cortex, bus, llm } = setup({
    cfg: { brain: { memory: { recall_k: 4 }, cortex: { recall_timeout_ms: 5000 } } },
    notes: () => undefined, // answered by hand below
  });
  await cortex.onEvent(say("amy"));
  const thinking = cortex.think(mention("amy", "remember my puppy?"));
  await waitFor(() => bus.of("memory.recall.request").length === 1 && bus.of("memory.notes.request").length === 1, "both requests");
  const [recall] = bus.of("memory.recall.request");
  const [notes] = bus.of("memory.notes.request");
  await cortex.onEvent(event("memory.recall.reply", { id: recall!.id, memories: [] }));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(llm.calls.length, 0, "still waiting for the notes");
  await cortex.onEvent(event("memory.notes.reply", { id: notes!.id, viewers: aliceNotes() }));
  await thinking;
  assert.match(llm.system, /- alice: got a new puppy named Biscuit/);
});

// @spec CTX-NOTES-002
test("notes are requested even when recall is off or has nothing to search for", async () => {
  const { cortex, bus } = setup(); // recall_k 0
  await cortex.think({ reason: "engaged", score: 1, focus: { kind: "chat", who: "amy", text: "", mention: false } });
  assert.equal(bus.of("memory.recall.request").length, 0);
  assert.equal(bus.of("memory.notes.request").length, 1);
});

// @spec CTX-NOTES-002
test("a silent memory costs the shared deadline, not the reply: no notes block, one warning, no text logged", async () => {
  const { cortex, bus, llm, rec } = setup({ cfg: { brain: { memory: { recall_k: 0 }, cortex: { recall_timeout_ms: 50 } } }, notes: () => undefined });
  const t0 = Date.now();
  await cortex.think(mention("amy"));
  assert.ok(Date.now() - t0 >= 45);
  assert.equal(llm.calls.length, 1);
  assert.equal(bus.of("brain.say").length, 1);
  assert.doesNotMatch(llm.system, /People here/);
  assert.deepEqual(rec.msgs("warn"), ["memory region did not answer the viewer-notes request in time"]);
});

// @spec CTX-NOTES-002
test("recall and notes share one deadline when both are silent: the wait is one timeout, not two", async () => {
  const { cortex } = setup({ cfg: { brain: { memory: { recall_k: 4 }, cortex: { recall_timeout_ms: 80 } } }, notes: () => undefined });
  const t0 = Date.now();
  await cortex.think(mention("amy"));
  assert.ok(Date.now() - t0 < 150, `waited ${Date.now() - t0} ms`);
});

// @spec CTX-NOTES-002
test("a failed publish of the notes request continues at once with no notes", async () => {
  const { cortex, bus, llm } = setup({ cfg: { brain: { memory: { recall_k: 0 }, cortex: { recall_timeout_ms: 5000 } } } });
  bus.fail = (t) => t === "memory.notes.request";
  const t0 = Date.now();
  await cortex.think(mention("amy"));
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(llm.calls.length, 1);
  assert.doesNotMatch(llm.system, /People here/);
});

// @spec CTX-NOTES-003
test("a notes reply resolves only the request with the same id; other and late ids are ignored", async () => {
  const { cortex, bus, llm } = setup({ cfg: { brain: { memory: { recall_k: 0 }, cortex: { recall_timeout_ms: 2000 } } }, notes: () => undefined });
  const thinking = cortex.think(mention("amy"));
  await waitFor(() => bus.of("memory.notes.request").length === 1, "request");
  await cortex.onEvent(event("memory.notes.reply", { id: "someone-else", viewers: [{ user: "mallory", regular: false, msgCount: 1, notes: [general("WRONG")] }] }));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(llm.calls.length, 0, "an unknown id does not release the think");
  await cortex.onEvent(event("memory.notes.reply", { id: bus.of("memory.notes.request")[0]!.id, viewers: aliceNotes() }));
  await thinking;
  assert.doesNotMatch(llm.system, /WRONG|mallory/);
  await cortex.onEvent(event("memory.notes.reply", { id: bus.of("memory.notes.request")[0]!.id, viewers: aliceNotes() })); // late duplicate: nothing pending
});

// @spec CTX-NOTES-004, CTX-NOTES-005
test("health and family notes reach the prompt as a handling hint only; the text never does", async () => {
  const { cortex, llm } = setup({
    notes: () => [{
      user: "alice", regular: true, msgCount: 40,
      notes: [general("plays Celeste"), { layer: "core", category: "family", hint: "check in warmly and gently; never name or quote it", strength: 1 }],
    }],
  });
  await cortex.think(mention("alice"));
  assert.match(llm.system, /- alice: plays Celeste\n {2}- handle gently: check in warmly and gently; never name or quote it\n/);
});

// @spec CTX-NOTES-006
test("subscriber and money detail never reach the prompt even if memory sends it", async () => {
  const { cortex, llm } = setup({ notes: () => [{ user: "alice", regular: true, msgCount: 40, isSub: true, subscriber: true, tier: "Tier 3", notes: [general("plays Celeste")] } as never] });
  await cortex.onEvent(event("chat.message", { platform: "twitch", user: "alice", text: "hey", isMod: false, isSub: true, mentionsCohost: true }));
  await cortex.think(mention("alice"));
  assert.match(llm.system, /alice: plays Celeste/);
  assert.doesNotMatch(llm.system, /subscri|tier|\bsub\b/i);
});

// @spec CTX-NOTES-007
test("notes live for one think only: a deleted note is absent from the next reply, and nothing is cached", async () => {
  let answer: NotesViewers = aliceNotes();
  const { cortex, bus, llm } = setup({ notes: () => answer });
  await cortex.think(mention("alice"));
  assert.match(llm.system, /Biscuit/);
  await cortex.onEvent(event("voice.done", { id: bus.of("brain.say")[0]!.id, sink: "x" }));
  answer = []; // the owner deleted the note
  await cortex.think(mention("alice"));
  assert.doesNotMatch(llm.system, /Biscuit|People here/);
  await cortex.onEvent(event("voice.done", { id: bus.of("brain.say")[1]!.id, sink: "x" }));
  answer = [];
  await cortex.onEvent(event("control", { cmd: "forget_context" }));
  await cortex.think(mention("alice"));
  assert.doesNotMatch(llm.system, /Biscuit/);
});

// @spec CTX-NOTES-008
test("note text never reaches logs at info or above, nor any brain.status detail; counts may", async () => {
  const { cortex, bus, rec } = setup({
    notes: () => [{ user: "alice", regular: true, msgCount: 40, notes: [general("TOPSECRET puppy"), { layer: "core", category: "health", hint: "HINTTEXT", strength: 1 }] }],
  });
  await cortex.think(mention("alice"));
  const loud = rec.lines.filter((l) => l.level !== "debug");
  assert.ok(!loud.some((l) => /TOPSECRET|HINTTEXT/.test(JSON.stringify([l.obj, l.msg]))));
  assert.ok(!bus.of("brain.status").some((s) => /TOPSECRET|HINTTEXT/.test(s.detail ?? "")));
  const counts = rec.lines.find((l) => l.msg === "viewer notes");
  assert.deepEqual(counts?.obj, { viewers: 1, notes: 2 });
});
