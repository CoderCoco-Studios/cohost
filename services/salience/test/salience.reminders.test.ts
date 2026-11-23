import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ModuleSchema } from "@cohost/config";
import { Module } from "@cohost/modules";
import { FakeBus, event, recordingLog, silentLog, testConfig } from "@cohost/testing";
import { Salience } from "../src/salience.js";
import { scoreRules, type ScoreInput, type ScoreOutput } from "../src/scoring.js";

/**
 * Due timer reminders (SAL-REM-001..008). Two clocks: the host wall clock that `dueAt` is measured against (`Date.now`,
 * mocked here), and the monotonic one salience takes for the cooldown and busy valves (injected).
 */
const WALL = 1_700_000_000_000;
const EXPIRY = 1_800_000; // brain.salience.reminder_expiry_ms default

afterEach(() => { mock.restoreAll(); });

function setup(over: { salience?: Record<string, unknown>; timer?: Record<string, unknown> } = {}) {
  let wall = WALL;
  let mono = 1_000_000;
  mock.method(Date, "now", () => wall);
  const cfg = testConfig({
    brain: { salience: { cooldown_ms: 0, idle_chatter_ms: 0, ...over.salience } },
    ...(over.timer ? { tools: { timer: over.timer } } : {}),
  });
  const bus = new FakeBus();
  const rec = recordingLog();
  const scorer = new Module<ScoreInput, ScoreOutput>("s", ModuleSchema.parse({}), cfg.llm, { rules: (i) => scoreRules(i, true) }, silentLog);
  const make = () => new Salience({ cfg, bus, scorer, log: rec.log, now: () => mono });
  return {
    s: make(), make, bus, rec,
    advance: (ms: number) => { wall += ms; mono += ms; },
  };
}
type H = ReturnType<typeof setup>;

const timer = (id: string, dueOffset = 0, note = `note ${id}`, extra: Record<string, unknown> = {}) =>
  event("tool.timer", { id, note, setAt: WALL - 600_000, dueAt: WALL + dueOffset, ...extra } as never);
const idle = event("brain.status", { state: "idle" });
const chat = (text: string, extra: Record<string, unknown> = {}) =>
  event("chat.message", { platform: "twitch", user: "bob", text, isMod: false, isSub: false, mentionsCohost: false, ...extra });
const focuses = (h: H) => h.bus.of("attention.focus");
const missedTimers = (h: H) => h.bus.of("tool.timer");

// @spec SAL-DECIDE-001, SAL-DECIDE-005, SAL-REM-005
test("a due reminder is published on a silent stream, as an attention.focus of kind reminder with only its text", async () => {
  const h = setup({ salience: { idle_chatter_ms: 0 } });
  await h.s.onEvent(timer("t1", -1000, "check the oven"));
  await h.s.tick();
  assert.deepEqual(focuses(h), [{ reason: "reminder", score: 1, focus: { kind: "reminder", text: "check the oven", mention: false } }]);
  assert.equal(h.bus.of("brain.say").length, 0, "a timer never speaks by itself");
});

// @spec SAL-DECIDE-005
test("a silent stream with no due reminder stays silent, even when idle chatter is due", async () => {
  const h = setup({ salience: { idle_chatter_ms: 1 } });
  h.advance(10_000);
  await h.s.tick();
  assert.equal(focuses(h).length, 0);
});

// @spec SAL-REM-005, SAL-DECIDE-001
test("a reminder is ahead of unseen events, which stay unseen for the next pass", async () => {
  const h = setup();
  await h.s.onEvent(chat("hey Coco?", { mentionsCohost: true }));
  await h.s.onEvent(timer("t1", -1000, "stretch"));
  await h.s.tick();
  assert.equal(focuses(h).length, 1);
  assert.equal(focuses(h)[0]!.reason, "reminder");
  assert.equal(h.s.ctx.unseen().length, 1, "the chat line was not scored or marked seen");
  await h.s.onEvent(idle);
  await h.s.tick();
  assert.equal(focuses(h).length, 2);
  assert.equal(focuses(h)[1]!.reason, "mentioned");
});

// @spec SAL-REM-005
test("the reminder focus carries no who, platform, userId, mention flag, timing or injection flag, and the reminder never enters the window", async () => {
  const h = setup();
  await h.s.onEvent(timer("t1", -1000));
  assert.equal(h.s.ctx.all().length, 0, "a reminder is not chat, speech or vision");
  await h.s.tick();
  const f = focuses(h)[0]!;
  for (const k of ["timing", "injected", "remember"] as const) assert.equal(k in f, false, k);
  for (const k of ["who", "platform", "userId", "source"] as const) assert.equal(k in f.focus!, false, k);
  assert.equal(f.focus!.mention, false);
  assert.equal(h.s.ctx.all().length, 0);
});

// @spec SAL-REM-004, SAL-DECIDE-001
test("muted, busy, cooling or paused: nothing is published for a reminder and it stays due", async () => {
  const h = setup({ salience: { cooldown_ms: 1000 } });
  await h.s.onEvent(timer("t1", -1000));

  await h.s.onEvent(event("control", { cmd: "mute" }));
  await h.s.tick();
  await h.s.onEvent(event("control", { cmd: "unmute" }));

  await h.s.onEvent(event("control", { cmd: "pause" }));
  await h.s.tick();
  await h.s.onEvent(event("control", { cmd: "resume" }));

  await h.s.onEvent(event("brain.status", { state: "thinking" }));
  await h.s.tick();
  await h.s.onEvent(idle);

  await h.s.onEvent(event("brain.say", { id: "x", text: "hi", emotion: "happy" })); // starts the cooldown
  await h.s.onEvent(idle);
  await h.s.tick();
  assert.equal(focuses(h).length, 0, "no gate lets a reminder through");
  assert.equal(missedTimers(h).length, 0, "and nothing is published for the timer");

  h.advance(1001); // the cooldown ends, well inside the expiry
  await h.s.tick();
  assert.equal(focuses(h).length, 1, "the reminder was kept due");
  assert.equal(focuses(h)[0]!.reason, "reminder");
});

// @spec SAL-REM-006
test("with several due reminders each pass publishes one, the earliest dueAt first, whatever the arrival order", async () => {
  const h = setup();
  await h.s.onEvent(timer("late", -1000, "late one"));
  await h.s.onEvent(timer("early", -5000, "early one"));
  await h.s.onEvent(timer("mid", -3000, "mid one"));
  const texts: string[] = [];
  for (let i = 0; i < 3; i++) {
    await h.s.tick();
    await h.s.tick(); // a second pass in the same busy state publishes nothing more
    await h.s.onEvent(idle);
    texts.push(focuses(h).at(-1)!.focus!.text);
    assert.equal(focuses(h).length, i + 1, "at most one focus per pass");
  }
  assert.deepEqual(texts, ["early one", "mid one", "late one"]);
});

// @spec SAL-REM-005
test("a reminder is removed once published: later passes do not repeat it", async () => {
  const h = setup();
  await h.s.onEvent(timer("t1", -1000));
  await h.s.tick();
  await h.s.onEvent(idle);
  await h.s.tick();
  await h.s.tick();
  assert.equal(focuses(h).length, 1);
});

// @spec SAL-HEALTH-002, SAL-REM-005
test("a failed reminder publish is logged, rolls back the thinking state, keeps the reminder due and the events unseen", async () => {
  const h = setup();
  await h.s.onEvent(chat("hello there"));
  await h.s.onEvent(timer("t1", -1000, "tea"));
  h.bus.fail = (t) => t === "attention.focus";
  await assert.doesNotReject(h.s.tick());
  assert.equal(h.rec.msgs("error").length, 1);
  assert.match(String(h.rec.msgs("error")[0]), /tick/);
  assert.equal(focuses(h).length, 0);
  assert.equal(h.s.ctx.unseen().length, 1);

  h.bus.fail = undefined;
  await h.s.tick(); // no brain.status needed: the busy state was rolled back
  assert.equal(focuses(h).length, 1);
  assert.deepEqual(focuses(h)[0]!.focus, { kind: "reminder", text: "tea", mention: false });
});

// @spec SAL-REM-002
test("a timer id that is held, spoken or carries missed is ignored", async () => {
  const h = setup();
  await h.s.onEvent(timer("t1", -1000, "first"));
  await h.s.onEvent(timer("t1", -500, "same id, held")); // held
  await h.s.onEvent(timer("m1", -1000, "gone", { missed: true })); // missed
  await h.s.tick();
  await h.s.onEvent(idle);
  await h.s.onEvent(timer("t1", -100, "same id, spoken")); // spoken
  await h.s.tick();
  await h.s.onEvent(idle);
  await h.s.tick();
  assert.deepEqual(focuses(h).map((f) => f.focus!.text), ["first"]);
  assert.equal(missedTimers(h).length, 0, "an ignored timer is not republished");
});

// @spec SAL-REM-002
test("salience remembers the last 64 spoken ids: the 65th evicts the first", async () => {
  const h = setup();
  for (let i = 1; i <= 65; i++) {
    await h.s.onEvent(timer(`id${i}`, -1000, `n${i}`));
    await h.s.tick();
    await h.s.onEvent(idle);
  }
  assert.equal(focuses(h).length, 65);
  await h.s.onEvent(timer("id65", -1000, "again 65")); // still remembered
  await h.s.tick();
  assert.equal(focuses(h).length, 65);
  await h.s.onEvent(timer("id1", -1000, "again 1")); // evicted
  await h.s.tick();
  assert.equal(focuses(h).length, 66);
  assert.equal(focuses(h)[65]!.focus!.text, "again 1");
});

// @spec SAL-REM-003, SAL-REM-001
test("a timer already more than the expiry past dueAt on arrival is dropped, republished with missed and never spoken", async () => {
  const h = setup();
  await h.s.onEvent(timer("old", -(EXPIRY + 1), "too late"));
  await h.s.tick();
  assert.equal(focuses(h).length, 0);
  assert.deepEqual(missedTimers(h), [{ id: "old", note: "too late", setAt: WALL - 600_000, dueAt: WALL - (EXPIRY + 1), missed: true }]);
  await h.s.onEvent(idle);
  await h.s.tick();
  assert.equal(missedTimers(h).length, 1, "republished once");
});

// @spec SAL-REM-003, SAL-REM-001
test("exactly the expiry past dueAt is still kept", async () => {
  const h = setup();
  await h.s.onEvent(timer("edge", -EXPIRY, "just in time"));
  await h.s.tick();
  assert.equal(missedTimers(h).length, 0);
  assert.equal(focuses(h).length, 1);
});

// @spec SAL-REM-003
test("a held reminder that ages past the expiry while the co-host is muted is not spoken late: it is republished with missed", async () => {
  const h = setup();
  await h.s.onEvent(event("control", { cmd: "mute" }));
  await h.s.onEvent(timer("t1", -1000, "stale soon"));
  await h.s.tick();
  h.advance(EXPIRY); // now more than the expiry past dueAt
  await h.s.onEvent(event("control", { cmd: "unmute" }));
  await h.s.tick();
  assert.equal(focuses(h).length, 0);
  assert.deepEqual(missedTimers(h), [{ id: "t1", note: "stale soon", setAt: WALL - 600_000, dueAt: WALL - 1000, missed: true }]);
});

// @spec SAL-REM-002, SAL-REM-003
test("the missed republish that returns over the bus is ignored", async () => {
  const h = setup();
  await h.s.onEvent(timer("old", -(EXPIRY + 1)));
  await h.s.tick();
  const [m] = missedTimers(h);
  await h.s.onEvent(event("tool.timer", m as never));
  await h.s.tick();
  assert.equal(missedTimers(h).length, 1);
  assert.equal(focuses(h).length, 0);
});

// @spec SAL-REM-001
test("the due list holds at most tools.timer.max_active entries and drops the oldest when full", async () => {
  const h = setup({ timer: { max_active: 2 } });
  await h.s.onEvent(timer("a", -3000, "a"));
  await h.s.onEvent(timer("b", -2000, "b"));
  await h.s.onEvent(timer("c", -1000, "c"));
  for (let i = 0; i < 3; i++) {
    await h.s.tick();
    await h.s.onEvent(idle);
  }
  assert.deepEqual(focuses(h).map((f) => f.focus!.text), ["b", "c"], "a, the oldest, was dropped");
});

// @spec SAL-REM-007
test("a timer arriving starts no decision pass", async () => {
  const h = setup({ salience: { trigger_on_speech: true } });
  await h.s.onEvent(timer("t1", -1000));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(focuses(h).length, 0, "nothing until the next poll");
  await h.s.tick();
  assert.equal(focuses(h).length, 1);
});

// @spec SAL-REM-008
test("a restarted salience holds no reminder, and does not read any back from the bus", async () => {
  const h = setup();
  await h.s.onEvent(timer("t1", -1000));
  await h.bus.putTimer("t1", JSON.stringify({ id: "t1", note: "n", setAt: WALL, dueAt: WALL - 1000 }));
  const again = h.make();
  await again.tick();
  assert.equal(focuses(h).length, 0);
  assert.equal(missedTimers(h).length, 0);
});

// @spec SAL-FOCUS-003
test("a speech focus passes on the source of the speech.heard", async () => {
  const h = setup({ salience: { trigger_on_speech: false } });
  await h.s.onEvent(event("speech.heard", { speaker: "Chris", text: "look at this", durationMs: 900, source: "discord" }));
  await h.s.tick();
  assert.deepEqual(focuses(h)[0]!.focus, { kind: "speech", who: "Chris", text: "look at this", source: "discord", mention: false });
});
