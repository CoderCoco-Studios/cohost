import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { ModuleSchema } from "@cohost/config";
import { Module } from "@cohost/modules";
import { FakeBus, event, silentLog, testConfig } from "@cohost/testing";
import { Salience } from "../src/salience.js";
import { scoreRules, type ScoreInput, type ScoreOutput } from "../src/scoring.js";

// Early reply, salience's half (SAL-PROV-*): an early pass over `speech.early` publishes a provisional `attention.focus`, and every
// provisional focus is resolved by exactly one `attention.resolve`. The clock is a fake `now`; the unresolved-limit timer is driven
// by node's mocked setTimeout, advanced together with the clock by `advance`.

const DIED = { match: "you died", say: ["Oof."], emotion: "surprised", gesture: "facepalm", cooldown_ms: 600000 };

function setup(salience: Record<string, unknown> = {}) {
  const cfg = testConfig({ brain: { salience: { cooldown_ms: 0, idle_chatter_ms: 0, ...salience } } });
  const bus = new FakeBus();
  let t = 1_000_000;
  let gate: Promise<void> | undefined;
  const inputs: ScoreInput[] = [];
  const scorer = new Module<ScoreInput, ScoreOutput>("s", ModuleSchema.parse({}), cfg.llm, { rules: (i) => scoreRules(i, true) }, silentLog);
  const run = scorer.run.bind(scorer);
  scorer.run = async (i) => { inputs.push(i); if (gate) await gate; return run(i); };
  const s = new Salience({ cfg, bus, scorer, log: silentLog, now: () => t });
  const hold = () => {
    let open!: () => void;
    gate = new Promise<void>((r) => (open = r));
    return () => { gate = undefined; open(); };
  };
  const advance = (ms: number) => {
    t += ms;
    try { mock.timers.tick(ms); } catch { /* setTimeout is mocked only by the tests that need the unresolved-limit timer */ }
  };
  const kinds = () => bus.published.map((p) => p.type === "attention.resolve" ? `resolve:${(p.data as { outcome: string }).outcome}` : p.type);
  return { s, bus, cfg, inputs, calls: () => inputs.length, hold, advance, kinds };
}
type Env = ReturnType<typeof setup>;

const early = (text: string, extra: Record<string, unknown> = {}) =>
  event("speech.early", { speaker: "Chris", source: "discord", text, utteranceId: "u1", seq: 0, sttMs: 120, ...extra });
const heard = (text: string, extra: Record<string, unknown> = {}) =>
  event("speech.heard", { speaker: "Chris", source: "discord", text, durationMs: 900, utteranceId: "u1", earlySeq: 0, ...extra });
const retracted = (seq = 0, utteranceId = "u1") => event("speech.retracted", { speaker: "Chris", source: "discord", utteranceId, seq });
const chat = (text: string, extra: Record<string, unknown> = {}) =>
  event("chat.message", { platform: "twitch", user: "bob", text, isMod: false, isSub: false, mentionsCohost: false, ...extra });
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
const focuses = (e: Env) => e.bus.of("attention.focus");
const resolves = (e: Env) => e.bus.of("attention.resolve");

/** Positive control for the "publishes nothing" tests: an early pass under these settings and no other obstacle does publish. */
async function controlPublishes(over: Record<string, unknown> = {}, prep: (e: Env) => Promise<void> = async () => {}): Promise<void> {
  const e = setup(over);
  await prep(e);
  await e.s.onEvent(early("look at this one"));
  await flush();
  assert.equal(focuses(e).length, 1, "control: the same setup without the obstacle publishes a provisional focus");
}

/** Runs an early pass to its provisional focus. */
async function provisional(over: Record<string, unknown> = {}, text = "look at this one", extra: Record<string, unknown> = {}): Promise<Env> {
  const e = setup(over);
  await e.s.onEvent(early(text, extra));
  await flush();
  assert.equal(focuses(e).length, 1, "precondition: a provisional focus was published");
  return e;
}

test("early: speech.early starts the early pass unawaited and a held scorer does not block the handler", async () => { // @spec SAL-PROV-001
  const e = setup();
  const open = e.hold();
  let returned = false;
  const handled = e.s.onEvent(early("look at this one")).then(() => { returned = true; });
  await flush();
  assert.ok(returned, "onEvent resolved while the scorer was held open");
  assert.equal(focuses(e).length, 0);
  open();
  await handled;
  await flush();
  assert.equal(focuses(e).length, 1);
});

test("early: a failing publish never rejects out of the handler", async () => { // @spec SAL-PROV-001
  const e = setup();
  e.bus.fail = (type) => type === "attention.focus";
  await assert.doesNotReject(e.s.onEvent(early("look at this one")));
  await flush();
  assert.equal(focuses(e).length, 0);
  assert.ok(e.calls() >= 1, "the pass did run");
});

test("early: trigger_on_speech false reads the early transcript and starts no pass", async () => { // @spec SAL-PROV-002
  const e = setup({ trigger_on_speech: false });
  await e.s.onEvent(early("look at this one"));
  await flush();
  assert.equal(e.calls(), 0, "the scorer is not asked");
  assert.equal(focuses(e).length, 0);
  await controlPublishes();
});

test("early: nothing while paused, while a decision is in flight (no rerun recorded), or while a record is held", async () => { // @spec SAL-PROV-003
  const paused = setup();
  await paused.s.onEvent(event("control", { cmd: "pause" }));
  await paused.s.onEvent(early("look at this one"));
  await flush();
  assert.equal(paused.calls(), 0, "paused: no pass");
  assert.equal(focuses(paused).length, 0);

  // A decision in flight: the early pass neither runs nor records a pending rerun, so nothing runs when the decision ends.
  const busy = setup({ speak_threshold: 100 });
  const open = busy.hold();
  await busy.s.onEvent(chat("hey there"));
  void busy.s.tick();
  await flush();
  assert.equal(busy.calls(), 1, "the poll's decision is in flight");
  await busy.s.onEvent(early("look at this one"));
  open();
  await flush();
  assert.equal(busy.calls(), 1, "no early pass and no rerun for it");

  // A held record: a second early transcript of another utterance starts nothing.
  const held = await provisional();
  const before = held.calls();
  await held.s.onEvent(early("something else entirely", { utteranceId: "u2" }));
  await flush();
  assert.equal(held.calls(), before, "no second pass");
  assert.equal(focuses(held).length, 1);
  assert.equal(resolves(held).length, 0);
});

test("early: a reflex match issues no provisional focus and stamps no cooldown, so the reflex fires on the final", async () => { // @spec SAL-PROV-004
  const e = setup({ reflexes: [DIED] });
  await e.s.onEvent(early("you died"));
  await flush();
  assert.equal(e.calls(), 0);
  assert.equal(focuses(e).length, 0);
  assert.equal(e.bus.of("brain.say").length, 0, "the early pass fires no reflex itself");
  await e.s.onEvent(heard("you died"));
  await flush();
  const say = e.bus.of("brain.say");
  assert.equal(say.length, 1, "the rule's own cooldown (600 s) was not spent by the early match test");
  assert.equal(say[0]!.reason, "reflex: you died");
  await controlPublishes({ reflexes: [DIED] });
});

test("early: muted, busy and cooldown each refuse the early pass before the scorer is asked", async () => { // @spec SAL-PROV-005
  const muted = setup();
  await muted.s.onEvent(event("control", { cmd: "mute" }));
  await muted.s.onEvent(early("look at this one"));
  await flush();
  assert.equal(muted.calls(), 0, "muted");
  assert.equal(focuses(muted).length, 0);

  const busy = setup();
  await busy.s.onEvent(event("brain.status", { state: "thinking" }));
  await busy.s.onEvent(early("look at this one"));
  await flush();
  assert.equal(busy.calls(), 0, "busy");
  assert.equal(focuses(busy).length, 0);

  const cooling = setup({ cooldown_ms: 6000 });
  await cooling.s.onEvent(event("brain.say", { id: "x", text: "hi", emotion: "neutral" }));
  await cooling.s.onEvent(event("brain.status", { state: "idle" }));
  await cooling.s.onEvent(early("look at this one"));
  await flush();
  assert.equal(cooling.calls(), 0, "cooldown");
  assert.equal(focuses(cooling).length, 0);
  await controlPublishes({ cooldown_ms: 6000 });
});

test("early: the transcript is scored as a transient speech event beside the unseen events and is never pushed into the window", async () => { // @spec SAL-PROV-006
  const e = setup({ speak_threshold: 1.2 });
  await e.s.onEvent(chat("is this good?")); // a question: 0.55; the early speech alone (0.9) is below 1.2
  const before = e.s.ctx.all().length;
  await e.s.onEvent(early("look at this one"));
  await flush();
  assert.equal(e.calls(), 1);
  const texts = e.inputs[0]!.events.map((x) => `${x.kind}:${x.text}`).sort();
  assert.deepEqual(texts, ["chat:is this good?", "speech:look at this one"]);
  assert.equal(e.s.ctx.all().length, before, "the early text is not in the Context");
  const [f] = focuses(e);
  assert.ok(f, "0.9 + 0.55 reaches the threshold");
  assert.ok(Math.abs(f!.score - 1.45) < 1e-9);
});

test("early: the early score is reused, with no scorer call, only by a final of the same utterance, earlySeq and text", async () => { // @spec SAL-PROV-007
  const e = setup({ speak_threshold: 1.2 }); // 0.9 < 1.2: no provisional focus, so the final is decided as ordinary
  await e.s.onEvent(early("look at this one"));
  await flush();
  assert.equal(e.calls(), 1);
  await e.s.onEvent(heard("look at this one"));
  await flush();
  assert.equal(e.calls(), 1, "a matching final reuses the score");

  for (const [name, extra, text] of [
    ["another utteranceId", { utteranceId: "u9" }, "look at this one"],
    ["another earlySeq", { earlySeq: 3 }, "look at this one"],
    ["another text", {}, "look at this two"],
  ] as const) {
    const o = setup({ speak_threshold: 1.2 });
    await o.s.onEvent(early("look at this one"));
    await flush();
    await o.s.onEvent(heard(text, extra));
    await flush();
    assert.equal(o.calls(), 2, `${name}: scored again`);
  }
});

test("early: below the threshold it publishes nothing, decides no idle chatter, and the final is an ordinary final", async () => { // @spec SAL-PROV-008, SAL-PROV-029
  const e = setup({ speak_threshold: 1.2, idle_chatter_ms: 10_000 });
  await e.s.onEvent(chat("hello")); // an unseen event makes idle chatter possible (SAL-DECIDE-005)
  e.advance(20_000);
  await e.s.onEvent(early("look at this one"));
  await flush();
  assert.equal(e.calls(), 1, "the early pass scored the chat line and the early text in one call (SAL-PROV-006)");
  assert.equal(focuses(e).length, 0, "no provisional focus and no idle chatter");
  assert.equal(resolves(e).length, 0);
  await e.s.onEvent(heard("look at this one that is long"));
  await flush();
  assert.equal(resolves(e).length, 0, "no record, no resolve");
});

test("early: the gates are re-checked once after the scorer and the pass publishes nothing when one now holds", async () => { // @spec SAL-PROV-009
  const cases: [string, (e: Env) => Promise<void>][] = [
    ["muted", (e) => e.s.onEvent(event("control", { cmd: "mute" }))],
    ["paused", (e) => e.s.onEvent(event("control", { cmd: "pause" }))],
    ["busy", (e) => e.s.onEvent(event("brain.say", { id: "x", text: "hi", emotion: "neutral", reason: "operator" }))],
    ["retracted", (e) => e.s.onEvent(retracted())],
    ["final arrived", (e) => e.s.onEvent(heard("look at this one"))],
  ];
  for (const [name, act] of cases) {
    const e = setup();
    const open = e.hold();
    await e.s.onEvent(early("look at this one"));
    await flush();
    await act(e);
    open();
    await flush();
    assert.equal(focuses(e).filter((f) => f.provisional).length, 0, `${name}: no provisional focus`);
    assert.equal(resolves(e).length, 0, `${name}: nothing to resolve`);
  }
  await controlPublishes();
});

test("early: the provisional focus carries provisional, utteranceId, seq, reason, score, the speech focus and the early timing, and nothing else", async () => { // @spec SAL-PROV-010
  const e = await provisional({}, "look at this one", { seq: 2, timing: { audioEndedAt: 5555 } });
  assert.deepEqual(focuses(e)[0], {
    reason: "engaged",
    score: 0.9,
    focus: { kind: "speech", who: "Chris", text: "look at this one", source: "discord", mention: false },
    provisional: true,
    utteranceId: "u1",
    seq: 2,
    timing: { audioEndedAt: 5555 },
  });
});

test("early: a provisional focus marks nothing seen, starts no cooldown, keeps the idle timer, and sets the state thinking", async () => { // @spec SAL-PROV-011, SAL-FOCUS-004, SAL-PROV-025
  const e = setup({ cooldown_ms: 6000 });
  await e.s.onEvent(chat("is this good?"));
  const idleBefore = (e.s.scheduler as unknown as { lastActivity: number }).lastActivity;
  e.advance(500);
  await e.s.onEvent(early("look at this one"));
  await flush();
  assert.equal(focuses(e).length, 1);
  assert.equal(e.s.ctx.unseen().length, 1, "the chat line stays unseen");
  assert.equal(e.s.scheduler.cooling(), false, "no cooldown");
  assert.equal((e.s.scheduler as unknown as { lastActivity: number }).lastActivity, idleBefore, "the idle timer is untouched");
  // The hold is the ordinary thinking valve: a poll during it is refused as busy.
  await e.s.onEvent(chat("hey Coco?", { mentionsCohost: true, user: "carol" }));
  await e.s.tick();
  assert.equal(focuses(e).length, 1, "busy on the thinking valve");
});

test("early: the unresolved limit counts from the publication, default 4000 ms, and ends in a timeout withdraw", async () => { // @spec SAL-PROV-012, SAL-PROV-021
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const e = await provisional();
    e.advance(3999);
    await flush();
    assert.equal(resolves(e).length, 0, "not yet");
    e.advance(1);
    await flush();
    assert.deepEqual(resolves(e), [{ utteranceId: "u1", seq: 0, outcome: "withdraw", reason: "timeout" }]);
    e.advance(60_000);
    await flush();
    assert.equal(resolves(e).length, 1, "exactly one");

    const custom = await provisional({ unresolved_limit_ms: 1000 });
    custom.advance(1000);
    await flush();
    assert.equal(resolves(custom)[0]!.reason, "timeout");
  } finally { mock.timers.reset(); }
});

test("early: the matching final publishes a confirm with the final's fields and timing, marks the scored events and the final seen, starts no cooldown", async () => { // @spec SAL-PROV-013, SAL-PROV-014, SAL-FOCUS-006
  const e = setup({ cooldown_ms: 6000 });
  await e.s.onEvent(chat("is this good?"));
  await e.s.onEvent(early("look at this one", { timing: { audioEndedAt: 1 } }));
  await flush();
  await e.s.onEvent(chat("and another thing?", { user: "carol" })); // arrives after the provisional decision: stays unseen
  const fin = heard("look at this one please", { timing: { audioEndedAt: 5000, closedAt: 4000 }, injected: true, remember: false });
  await e.s.onEvent(fin);
  await flush();
  // The confirm carries the held record's reason and score (SAL-PROV-013): the provisional decision scored the chat line (0.55)
  // and the early speech (0.9), as SAL-PROV-006 asserts. Written as the sum the walk adds (0.9 first), which is exact in floats.
  assert.deepEqual(resolves(e), [{
    utteranceId: "u1", seq: 0, outcome: "confirm", reason: "engaged", score: 0.9 + 0.55,
    focus: { kind: "speech", who: "Chris", text: "look at this one please", source: "discord", mention: false },
    injected: true, remember: false,
    timing: { audioEndedAt: 5000, closedAt: 4000, heardAt: fin.ts },
  }]);
  assert.deepEqual(e.s.ctx.unseen().map((x) => x.kind === "chat" ? x.text : "other"), ["and another thing?"], "only the later chat line is unseen");
  assert.equal(e.s.scheduler.cooling(), false, "no cooldown until the reply's brain.say");
  await e.s.onEvent(chat("hey Coco?", { mentionsCohost: true, user: "dave" }));
  await e.s.tick();
  assert.equal(focuses(e).length, 1, "the state is thinking after a confirm");
});

test("early: a confirmed final starts no second decision", async () => { // @spec SAL-TRIG-001, SAL-PROV-013
  const e = await provisional();
  const before = e.calls();
  await e.s.onEvent(heard("look at this one"));
  await flush();
  await e.s.tick();
  assert.equal(e.calls(), before, "the scorer is not asked again");
  assert.equal(focuses(e).length, 1, "only the provisional focus");
  assert.equal(resolves(e).length, 1);
});

test("early: a final with another earlySeq or none withdraws as resumed and is then decided at once, not refused as busy", async () => { // @spec SAL-PROV-015, SAL-PROV-030, SAL-TRIG-001
  for (const extra of [{ earlySeq: 7 }, { earlySeq: undefined }]) {
    const e = await provisional();
    await e.s.onEvent(heard("look at this one and more", extra));
    await flush();
    assert.deepEqual(e.kinds().slice(-3), ["attention.focus", "resolve:withdraw", "attention.focus"]);
    assert.equal(resolves(e)[0]!.reason, "resumed");
    const second = focuses(e)[1]!;
    assert.equal(second.provisional, undefined);
    assert.equal(second.focus?.text, "look at this one and more");
  }
});

test("early: a retraction of the held seq withdraws as resumed and frees the state; another seq or none is ignored", async () => { // @spec SAL-PROV-016, SAL-PROV-017, SAL-PROV-030
  const none = setup();
  await none.s.onEvent(retracted());
  assert.equal(resolves(none).length, 0, "no record: ignored");

  const e = await provisional({}, "look at this one", { seq: 2 });
  await e.s.onEvent(retracted(5));
  await e.s.onEvent(retracted(2, "other"));
  assert.equal(resolves(e).length, 0, "another seq or utterance: ignored");
  await e.s.onEvent(retracted(2));
  assert.deepEqual(resolves(e), [{ utteranceId: "u1", seq: 2, outcome: "withdraw", reason: "resumed" }]);
  await e.s.onEvent(chat("hey Coco?", { mentionsCohost: true }));
  await e.s.tick();
  assert.equal(focuses(e).length, 2, "the state is idle at once: the next decision is not refused as busy");
});

test("early: mute, pause and forget_context withdraw at once with their reason", async () => { // @spec SAL-PROV-018, SAL-PROV-019, SAL-PROV-030
  for (const [cmd, reason] of [["mute", "muted"], ["pause", "paused"], ["forget_context", "forgotten"]] as const) {
    const e = await provisional();
    await e.s.onEvent(event("control", { cmd }));
    assert.deepEqual(resolves(e), [{ utteranceId: "u1", seq: 0, outcome: "withdraw", reason }], cmd);
  }
  const other = await provisional();
  await other.s.onEvent(event("control", { cmd: "mute", target: "cortex" }));
  assert.equal(resolves(other).length, 0, "a command for another service changes nothing");
});

test("early: any brain.say withdraws as superseded and leaves the state it set", async () => { // @spec SAL-PROV-020, SAL-PROV-031
  for (const reason of ["operator", "reflex: x", undefined]) {
    const e = await provisional();
    await e.s.onEvent(event("brain.say", { id: "x", text: "hi", emotion: "neutral", ...(reason ? { reason } : {}) }));
    assert.deepEqual(resolves(e), [{ utteranceId: "u1", seq: 0, outcome: "withdraw", reason: "superseded" }]);
    await e.s.onEvent(chat("hey Coco?", { mentionsCohost: true }));
    await e.s.tick();
    assert.equal(focuses(e).length, 1, "state stays speaking: still busy, not idle");
  }
});

test("early: an ordinary focus after a stray idle status withdraws the held record as superseded, resolve first", async () => { // @spec SAL-PROV-026, SAL-PROV-027, SAL-PROV-020
  const e = await provisional();
  await e.s.onEvent(event("brain.status", { state: "idle" }));
  assert.equal(resolves(e).length, 0, "an idle status keeps the record");
  await e.s.onEvent(chat("hey Coco?", { mentionsCohost: true }));
  await e.s.tick();
  assert.deepEqual(e.kinds().slice(-2), ["resolve:withdraw", "attention.focus"]);
  assert.equal(resolves(e)[0]!.reason, "superseded");
  assert.equal(focuses(e)[1]!.focus?.kind, "chat");
});

test("early: a withdraw marks nothing seen, starts no cooldown and drops the cached early score", async () => { // @spec SAL-PROV-022
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const e = setup({ cooldown_ms: 6000 });
    await e.s.onEvent(chat("is this good?"));
    await e.s.onEvent(early("look at this one"));
    await flush();
    e.advance(4000);
    await flush();
    assert.equal(resolves(e)[0]!.reason, "timeout");
    assert.equal(e.s.ctx.unseen().length, 1, "nothing marked seen");
    assert.equal(e.s.scheduler.cooling(), false, "no cooldown");
    const before = e.calls();
    // The same final that would have reused the early score now has to be scored.
    await e.s.onEvent(heard("look at this one"));
    await flush();
    assert.equal(e.calls(), before + 1, "the cache was dropped at the withdraw");
  } finally { mock.timers.reset(); }
});

test("early: exactly one resolve per provisional focus, whichever path comes first", async () => { // @spec SAL-PROV-023
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const e = await provisional();
    await e.s.onEvent(retracted());
    await e.s.onEvent(retracted());
    await e.s.onEvent(event("control", { cmd: "mute" }));
    await e.s.onEvent(event("brain.say", { id: "x", text: "hi", emotion: "neutral" }));
    e.advance(60_000);
    await flush();
    assert.equal(resolves(e).length, 1);

    const confirmed = await provisional();
    await confirmed.s.onEvent(heard("look at this one"));
    confirmed.advance(60_000);
    await confirmed.s.onEvent(event("control", { cmd: "forget_context" }));
    await flush();
    assert.equal(resolves(confirmed).length, 1, "a confirm leaves nothing for the timer or a later command");

    // A fresh provisional focus after a resolve is resolved on its own.
    const again = await provisional();
    await again.s.onEvent(retracted());
    await again.s.onEvent(event("brain.status", { state: "idle" }));
    await again.s.onEvent(early("look again", { seq: 1 }));
    await flush();
    await again.s.onEvent(retracted(1));
    assert.deepEqual(resolves(again).map((r) => r.seq), [0, 1]);
  } finally { mock.timers.reset(); }
});

test("early: a final or retraction during scoring cancels nothing and the pass publishes nothing", async () => { // @spec SAL-PROV-024
  for (const act of [(e: Env) => e.s.onEvent(heard("look at this one")), (e: Env) => e.s.onEvent(retracted())]) {
    const e = setup();
    const open = e.hold();
    await e.s.onEvent(early("look at this one"));
    await flush();
    await act(e);
    open();
    await flush();
    assert.equal(focuses(e).filter((f) => f.provisional).length, 0);
    assert.equal(resolves(e).length, 0);
    assert.ok(e.calls() >= 1, "the early scorer call was not cancelled");
  }
});

test("early: an early pass is a decision in flight, a final during it records one rerun that reuses the cached score", async () => { // @spec SAL-PROV-032, SAL-PROV-033
  const e = setup();
  const open = e.hold();
  await e.s.onEvent(early("look at this one"));
  await flush();
  await e.s.tick(); // a poll during the early pass is a no-op (SAL-FOCUS-002)
  assert.equal(e.calls(), 1, "no second scorer call from the poll");
  await e.s.onEvent(heard("look at this one"));
  await flush();
  assert.equal(e.calls(), 1, "the final starts no pass of its own");
  open();
  await flush();
  assert.equal(e.calls(), 1, "the rerun reused the early score");
  assert.equal(focuses(e).length, 1, "the early pass published nothing; the rerun decided the final");
  assert.equal(focuses(e)[0]!.provisional, undefined);
  assert.equal(focuses(e)[0]!.focus?.text, "look at this one");
  assert.equal(resolves(e).length, 0);
});

test("early: the cached early score is dropped once the final is handled", async () => { // @spec SAL-PROV-034
  const e = setup({ speak_threshold: 1.2 });
  await e.s.onEvent(early("look at this one"));
  await flush();
  assert.equal(e.calls(), 1, "the early pass scored");
  await e.s.onEvent(heard("look at this one"));
  await flush();
  assert.equal(e.calls(), 1, "reused by the final");
  await e.s.onEvent(heard("look at this one")); // the same ids and text again: the cache is gone
  await flush();
  assert.equal(e.calls(), 2);
});

test("early: a speech focus whose event carries an utteranceId sets it; one without sets none", async () => { // @spec SAL-PROV-028
  const e = setup();
  await e.s.onEvent(heard("look at this one", { earlySeq: undefined }));
  await flush();
  const [f] = focuses(e);
  assert.equal(f!.utteranceId, "u1");
  assert.equal(f!.provisional, undefined);
  assert.equal(f!.seq, undefined);
  const bare = setup();
  await bare.s.onEvent(heard("look at this one", { utteranceId: undefined, earlySeq: undefined }));
  await flush();
  assert.equal(focuses(bare)[0]!.utteranceId, undefined);
});

test("early: a withdraw sent while the provisional focus is still publishing is ordered behind it on the bus", async () => { // @spec SAL-PROV-023
  const e = setup();
  const realPublish = e.bus.publish.bind(e.bus) as typeof e.bus.publish;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  e.bus.publish = (async (type: Parameters<typeof realPublish>[0], data: Parameters<typeof realPublish>[1]) => {
    if (type === "attention.focus") await gate; // the focus is in flight while the withdraw is sent
    return realPublish(type, data);
  }) as typeof e.bus.publish;
  await e.s.onEvent(early("look at this one"));
  await flush(); // the scorer has returned; the focus publish waits on the gate
  await e.s.onEvent(event("control", { cmd: "mute" }));
  await flush();
  assert.deepEqual(e.kinds(), [], "nothing is on the bus while the focus is in flight");
  release();
  await flush();
  assert.deepEqual(e.kinds(), ["attention.focus", "resolve:withdraw"], "the resolve follows its focus");
  assert.equal(resolves(e)[0]!.reason, "muted");
});
