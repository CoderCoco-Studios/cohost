import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { ModuleSchema } from "@cohost/config";
import { Module } from "@cohost/modules";
import { FakeBus, event, recordingLog, silentLog, testConfig } from "@cohost/testing";
import { Salience } from "../src/salience.js";
import { scoreRules, type ScoreInput, type ScoreOutput } from "../src/scoring.js";

// Speech trigger: a final speech.heard starts a decision at once (SAL-TRIG-*). The fake clock is never advanced in these tests, so
// any focus they see came from the trigger, not from the poll or a cooldown ending.

const DIED = { match: "you died", say: ["Oof."], emotion: "surprised", gesture: "facepalm", cooldown_ms: 0 };

function setup(salience: Record<string, unknown> = {}, log: typeof silentLog = silentLog, now: () => number = () => 1_000_000) {
  const cfg = testConfig({ brain: { salience: { cooldown_ms: 0, idle_chatter_ms: 0, ...salience } } });
  const bus = new FakeBus();
  let gate: Promise<void> | undefined;
  const scorer = new Module<ScoreInput, ScoreOutput>("s", ModuleSchema.parse({}), cfg.llm, {
    rules: (i) => scoreRules(i, true),
  }, silentLog);
  const run = scorer.run.bind(scorer);
  scorer.run = async (i) => { if (gate) await gate; return run(i); };
  const s = new Salience({ cfg, bus, scorer, log, now });
  // Every scheduling pass goes through Scheduler.decide; counting its calls counts passes that got past the in-flight guard.
  const sched = (s as unknown as { scheduler: { decide: (...a: unknown[]) => Promise<unknown> } }).scheduler;
  const decide = mock.method(sched, "decide");
  // A gate that holds the scorer open until `open()`, so a decision can be kept in flight.
  const hold = () => {
    let open!: () => void;
    gate = new Promise<void>((r) => (open = r));
    return () => { gate = undefined; open(); };
  };
  return { s, bus, decide, passes: () => decide.mock.callCount(), hold };
}
const speech = (text: string, extra: Record<string, unknown> = {}) =>
  event("speech.heard", { speaker: "Chris", text, durationMs: 900, ...extra });
const chat = (text: string, extra: Record<string, unknown> = {}) =>
  event("chat.message", { platform: "twitch", user: "bob", text, isMod: false, isSub: false, mentionsCohost: false, ...extra });
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

test("trigger: a speech.heard publishes attention.focus with no tick call and no clock advance", async () => { // @spec SAL-TRIG-001
  const { s, bus } = setup();
  const tick = mock.method(s, "tick");
  await s.onEvent(speech("look at this"));
  await flush();
  assert.equal(bus.of("attention.focus").length, 1);
  assert.deepEqual(bus.of("attention.focus")[0]!.focus, { kind: "speech", who: "Chris", text: "look at this", mention: false });
  assert.equal(tick.mock.callCount(), 1, "the trigger runs the same tick() pass the poll runs");
});

test("trigger: only speech.heard starts a decision", async () => { // @spec SAL-TRIG-002
  const { s, bus, passes } = setup({ speak_threshold: 0.3 });
  await s.onEvent(chat("hey Coco?", { mentionsCohost: true }));
  await s.onEvent(event("vision.summary", { text: "a dragon", changed: true }));
  await s.onEvent(event("speech.partial", { speaker: "Chris", source: "http", text: "look at", utteranceId: "u1", seq: 0 }));
  await s.onEvent(event("brain.status", { state: "idle" }));
  await s.onEvent(event("brain.say", { id: "x", text: "hi", emotion: "neutral" }));
  await s.onEvent(event("brain.status", { state: "idle" }));
  await s.onEvent(event("affect.state", { valence: 0, arousal: 0.5, mood: "neutral" }));
  await s.onEvent(event("control", { cmd: "unmute" }));
  await flush();
  assert.equal(passes(), 0, "no decision pass started");
  assert.equal(bus.of("attention.focus").length, 0);
  await s.tick();
  assert.equal(bus.of("attention.focus").length, 1, "the same state is decided by the poll");
  // Positive control: the one event type that does start a pass.
  await s.onEvent(event("brain.status", { state: "idle" }));
  const before = passes();
  await s.onEvent(speech("now speech"));
  await flush();
  assert.equal(passes() - before, 1, "a speech.heard starts exactly one pass");
});

test("trigger: a line a reflex answered starts no decision", async () => { // @spec SAL-TRIG-003
  const { s, bus } = setup({ reflexes: [DIED] });
  const tick = mock.method(s, "tick");
  await s.onEvent(speech("you died"));
  await flush();
  assert.equal(bus.of("brain.say").length, 1, "the reflex fired");
  assert.equal(tick.mock.callCount(), 0, "no pass for a reflex-handled line");
  assert.equal(bus.of("attention.focus").length, 0);
  // A line the reflex does not match still triggers.
  const other = setup({ reflexes: [DIED] });
  await other.s.onEvent(speech("something else"));
  await flush();
  assert.equal(other.bus.of("attention.focus").length, 1);
});

test("trigger: the handler returns before a slow decision finishes and the decision still completes", async () => { // @spec SAL-TRIG-004
  const { s, bus, hold } = setup();
  const open = hold();
  let returned = false;
  const handled = s.onEvent(speech("look at this")).then(() => { returned = true; });
  await flush();
  assert.ok(returned, "onEvent resolved while the scorer was still held open");
  assert.equal(bus.of("attention.focus").length, 0, "decision not finished yet");
  // Intake of the next event is not delayed by the open decision.
  await s.onEvent(chat("another line"));
  open();
  await handled;
  await flush();
  assert.equal(bus.of("attention.focus").length, 1);
});

test("trigger: any number of utterances during one decision produce exactly one rerun", async () => { // @spec SAL-TRIG-005
  const { s, bus, passes, hold } = setup({ speak_threshold: 100 });
  const open = hold();
  await s.onEvent(speech("one"));
  await flush();
  assert.equal(passes(), 1, "first trigger started a pass");
  await s.onEvent(speech("two"));
  await s.onEvent(speech("three"));
  await s.onEvent(speech("four"));
  await flush();
  assert.equal(passes(), 1, "triggers during the decision start no pass of their own");
  open();
  await flush();
  assert.equal(passes(), 2, "one rerun for three mid-decision utterances");
  assert.equal(bus.of("attention.focus").length, 0);
});

test("trigger: an utterance that lands mid-decision is evaluated by the rerun without waiting for the poll", async () => { // @spec SAL-TRIG-005
  // One 0.9 line is below the 1.5 bar; the second, which lands while the first is being scored, takes the sum over it.
  const { s, bus, passes, hold } = setup({ speak_threshold: 1.5 });
  const open = hold();
  await s.onEvent(speech("one"));
  await flush();
  await s.onEvent(speech("two"));
  open();
  await flush();
  assert.equal(passes(), 2);
  assert.equal(bus.of("attention.focus").length, 1, "the late utterance was not lost");
});

test("trigger: while paused a speech.heard starts no decision and records no rerun", async () => { // @spec SAL-TRIG-006
  const { s, bus, passes } = setup();
  await s.onEvent(event("control", { cmd: "pause" }));
  await s.onEvent(speech("hello"));
  await flush();
  assert.equal(passes(), 0);
  await s.onEvent(event("control", { cmd: "resume" }));
  await flush();
  assert.equal(passes(), 0, "no rerun recorded during the pause ran on resume");
  assert.equal(bus.of("attention.focus").length, 0);

  // A rerun recorded before a pause does not run while the pause holds.
  const b = setup({ speak_threshold: 100 });
  const open = b.hold();
  await b.s.onEvent(speech("one"));
  await flush();
  await b.s.onEvent(speech("two"));
  await b.s.onEvent(event("control", { cmd: "pause" }));
  open();
  await flush();
  assert.equal(b.passes(), 1, "only the original pass, the rerun is held by the pause");
});

test("trigger: trigger_on_speech defaults to on, and when false only the poll starts a decision", async () => { // @spec SAL-TRIG-007, SAL-TRIG-001
  const on = setup();
  await on.s.onEvent(speech("hello"));
  await flush();
  assert.equal(on.bus.of("attention.focus").length, 1, "default: triggered");

  const off = setup({ trigger_on_speech: false });
  await off.s.onEvent(speech("hello"));
  await flush();
  assert.equal(off.passes(), 0);
  assert.equal(off.bus.of("attention.focus").length, 0);
  await off.s.tick();
  assert.equal(off.bus.of("attention.focus").length, 1, "the poll still decides");
});

test("trigger: a trigger and the poll never focus the same event twice", async () => { // @spec SAL-TRIG-008
  const first = setup();
  await first.s.onEvent(speech("hello"));
  await flush();
  assert.equal(first.bus.of("attention.focus").length, 1, "the trigger focused it before any poll");
  await first.s.onEvent(event("brain.status", { state: "idle" }));
  await first.s.tick();
  assert.equal(first.bus.of("attention.focus").length, 1, "the poll after a trigger does not focus it again");
  const { s, bus, hold } = setup();
  // Concurrent: the trigger's decision is in flight when the poll ticks.
  const open = hold();
  await s.onEvent(speech("hello"));
  const polled = s.tick();
  open();
  await polled;
  await flush();
  assert.equal(bus.of("attention.focus").length, 1);
  await s.onEvent(event("brain.status", { state: "idle" }));
  await s.tick();
  assert.equal(bus.of("attention.focus").length, 1, "the seen event is not focused again");
});

test("trigger: muted, cooldown and a busy cortex withhold a triggered focus exactly as they do for the poll", async () => { // @spec SAL-TRIG-008
  let clock = 1_000_000;
  const now = () => clock;
  // muted
  const m = setup({}, silentLog, now);
  await m.s.onEvent(event("control", { cmd: "mute" }));
  await m.s.onEvent(speech("hello"));
  await flush();
  assert.equal(m.bus.of("attention.focus").length, 0, "muted");
  assert.ok(m.passes() >= 1, "the trigger did decide, and the decision said no");
  // busy cortex
  const b = setup({}, silentLog, now);
  await b.s.onEvent(event("brain.status", { state: "thinking" }));
  await b.s.onEvent(speech("hello"));
  await flush();
  assert.equal(b.bus.of("attention.focus").length, 0, "cortex busy");
  assert.ok(b.passes() >= 1);
  // cooldown
  const c = setup({ cooldown_ms: 6000 }, silentLog, now);
  await c.s.onEvent(event("brain.say", { id: "x", text: "hi", emotion: "neutral" }));
  await c.s.onEvent(event("brain.status", { state: "idle" }));
  await c.s.onEvent(speech("hello"));
  await flush();
  assert.equal(c.bus.of("attention.focus").length, 0, "cooldown");
  assert.ok(c.passes() >= 1);
  clock += 7000;
  await c.s.tick();
  assert.equal(c.bus.of("attention.focus").length, 1, "the poll publishes once the gate opens");
});

test("trigger: a failed decision or publish is logged, never rejects, and a pending rerun still runs once", async () => { // @spec SAL-TRIG-009
  const rec = recordingLog();
  const { s, bus, passes, hold } = setup({}, rec.log);
  let failures = 0;
  bus.fail = (type) => type === "attention.focus" && failures++ < 1;
  const open = hold();
  await assert.doesNotReject(s.onEvent(speech("one")));
  await flush();
  await s.onEvent(speech("two")); // lands mid-decision: pending rerun
  open();
  await flush();
  assert.equal(rec.lines.filter((l) => l.level === "error" && l.msg === "tick failed").length, 1, "the failure is logged once");
  assert.equal(passes(), 2, "the rerun ran exactly once after the failed pass");
  assert.equal(bus.of("attention.focus").length, 1, "the rerun published after the rollback");

  // No rerun pending: a failed triggered publish rejects nothing out of the handler.
  const lone = setup({}, rec.log);
  lone.bus.fail = (type) => type === "attention.focus";
  await assert.doesNotReject(lone.s.onEvent(speech("solo")));
  await flush();
  assert.equal(lone.passes(), 1);
});
