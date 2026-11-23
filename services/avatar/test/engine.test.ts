import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import type { Emotion } from "@cohost/config";
import { Engine } from "../src/engine.js";
import type { AvatarDriver, AvatarParams } from "../src/types.js";

// @spec AVATAR-DRV-001
class FakeDriver implements AvatarDriver {
  readonly name = "fake";
  params: AvatarParams[] = [];
  expressions: [Emotion, number][] = [];
  gestures: string[] = [];
  async connect() {}
  async disconnect() {}
  connected() { return true; }
  setParams(p: AvatarParams) { this.params.push({ ...p }); }
  setExpression(e: Emotion, i: number) { this.expressions.push([e, i]); }
  trigger(g: string) { this.gestures.push(g); }
  get last() { return this.params[this.params.length - 1]!; }
}

// fps 10 → one frame per 100 ms; smoothing 1 → no easing, so each frame shows its target exactly.
const avatarCfg = (over: Record<string, unknown> = {}) =>
  ({ driver: "null", fps: 10, smoothing: 1, idle_motion: false, vtube_studio: {}, vmc: {}, ...over }) as never;
const utterance = (over: Record<string, unknown> = {}) =>
  ({ id: "u1", seq: 0, emotion: "happy" as Emotion, envelope: [0.8, 0.4, 0.2], envelopeHz: 10, durationMs: 300, ...over });

let driver: FakeDriver;
let states: { emotion: Emotion; intensity: number }[];
let engine: Engine;
const make = (over: Record<string, unknown> = {}) => {
  engine = new Engine(avatarCfg(over), driver, (_p, emotion, intensity) => states.push({ emotion, intensity }), () => Date.now()); // the mocked Date is the engine clock
  engine.start();
  return engine;
};
// One tick per frame: a single long tick() moves the mocked clock to the end before firing the intervals.
const frames = (n: number) => { for (let i = 0; i < n; i++) mock.timers.tick(100); };

beforeEach(() => {
  mock.timers.enable({ apis: ["setInterval", "Date"], now: 1_000_000 });
  driver = new FakeDriver();
  states = [];
});
afterEach(() => { engine?.stop(); mock.timers.reset(); });

test("runs at cfg.fps and pushes params to the driver every frame", () => { // @spec AVATAR-ENG-001
  make();
  frames(5);
  assert.equal(driver.params.length, 5);
  assert.equal(states.length, 5);
  engine.stop();
  frames(5);
  assert.equal(driver.params.length, 5);
});

test("the frame timer is unref'd so it cannot hold the process open, and stop clears it", () => { // @spec AVATAR-ENG-018
  mock.timers.reset(); // a real timer: the mocked one does not track references
  const real = new Engine(avatarCfg(), driver);
  try {
    real.start();
    const timer = (real as unknown as { timer: { hasRef(): boolean } }).timer;
    assert.equal(timer.hasRef(), false);
  } finally {
    real.stop();
  }
});

test("lip-sync follows the envelope from when the sink starts playing, then closes", () => { // @spec AVATAR-ENG-005
  make();
  engine.prepare(utterance());
  frames(1);
  assert.equal(driver.last.mouthOpen, 0); // prepared, not playing yet
  engine.play("u1", 0);
  const mouth: number[] = [];
  for (let i = 0; i < 4; i++) { frames(1); mouth.push(driver.last.mouthOpen); }
  assert.deepEqual(mouth, [0.4, 0.2, 0, 0]); // 100ms in → envelope[1], ...; past the end → closed
});

test("play() sets the utterance emotion at full intensity and fires its gesture", () => { // @spec AVATAR-ENG-003
  make();
  engine.prepare(utterance({ gesture: "wave" }));
  engine.play("u1", 0);
  assert.deepEqual(driver.expressions, [["happy", 1]]);
  assert.deepEqual(driver.gestures, ["wave"]);
});

test("play() of an unknown or evicted id is ignored (only the last 50 are kept)", () => { // @spec AVATAR-ENG-002, AVATAR-ENG-004
  make();
  for (let i = 0; i < 51; i++) engine.prepare(utterance({ id: `u${i}`, gesture: "nod" }));
  engine.play("u0", 0);
  engine.play("nope", 0);
  assert.equal(driver.expressions.length, 0);
  engine.play("u50", 0);
  assert.deepEqual(driver.gestures, ["nod"]);
});

test("done() closes the mouth immediately; done() for another id does not", () => { // @spec AVATAR-ENG-007
  make();
  engine.prepare(utterance({ envelope: [0.9, 0.9, 0.9, 0.9, 0.9], durationMs: 500 }));
  engine.play("u1", 0);
  frames(1);
  engine.done("other", 0);
  frames(1);
  assert.equal(driver.last.mouthOpen, 0.9);
  engine.done("u1", 0);
  frames(1);
  assert.equal(driver.last.mouthOpen, 0);
});

test("a held emotion decays to the resting mood once its hold runs out", () => { // @spec AVATAR-ENG-008, AVATAR-ENG-009, AVATAR-ENG-011, AVATAR-ENG-016
  make();
  engine.setMood("smug");
  assert.deepEqual(driver.expressions, [["smug", 0.5]]); // nothing held: mood shows right away, softly
  engine.setEmotion("surprised", 1000);
  frames(5);
  assert.equal(states.at(-1)!.emotion, "surprised");
  assert.equal(states.at(-1)!.intensity, 1);
  frames(6);
  assert.deepEqual(driver.expressions.at(-1), ["smug", 0.5]);
  assert.deepEqual(states.at(-1), { emotion: "smug", intensity: 0.5 });
});

test("a mood change while an utterance holds the face waits for the hold to end", () => { // @spec AVATAR-ENG-008, AVATAR-ENG-010
  make();
  engine.setEmotion("angry", 1000);
  engine.setMood("happy");
  assert.deepEqual(driver.expressions, [["angry", 1]]);
  engine.setMood("happy"); // same mood again is a no-op
  frames(11);
  assert.deepEqual(driver.expressions, [["angry", 1], ["happy", 0.5]]);
});

test("returning to a neutral mood clears the expression (intensity 0)", () => { // @spec AVATAR-ENG-009, AVATAR-ENG-016
  make();
  engine.setMood("sad");
  engine.setMood("neutral");
  assert.deepEqual(driver.expressions.at(-1), ["neutral", 0]);
  frames(1);
  assert.deepEqual(states.at(-1), { emotion: "neutral", intensity: 0 });
});

test("smile follows the emotion", () => { // @spec AVATAR-ENG-012
  make();
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
  frames(1);
  assert.ok(near(driver.last.mouthSmile, 0.15));
  for (const e of ["happy", "laugh", "smug"] as const) {
    engine.setEmotion(e);
    frames(1);
    assert.ok(near(driver.last.mouthSmile, 0.7), e);
  }
  engine.setEmotion("sad");
  frames(1);
  assert.ok(near(driver.last.mouthSmile, 0.15));
});

test("idle motion moves the head and eyes only when enabled", () => { // @spec AVATAR-ENG-013
  make();
  frames(20);
  assert.ok(driver.params.every((p) => p.headX === 0 && p.headY === 0 && p.eyeX === 0));
  engine.stop();
  driver = new FakeDriver();
  make({ idle_motion: true });
  frames(20);
  assert.ok(driver.params.some((p) => p.headX !== 0 && p.headY !== 0 && p.headZ !== 0 && p.eyeX !== 0 && p.eyeY !== 0));
  assert.ok(driver.params.every((p) => Math.abs(p.headX) <= 6 && Math.abs(p.eyeX) <= 0.35));
});

test("blinks: the first after ~3s, eyes shut briefly then open again", () => { // @spec AVATAR-ENG-014
  make();
  frames(30); // up to and including t0 + 3000 ms
  assert.ok(driver.params.every((p) => p.blink === 0));
  frames(1);
  assert.equal(driver.last.blink, 1); // the 3100 ms frame is the first past nextBlink
  frames(2);
  assert.equal(driver.params.filter((p) => p.blink === 1).length, 2); // 120 ms spans the next 100 ms frame too
  assert.equal(driver.last.blink, 0);
});

test("smoothing eases the head, while the mouth moves 3x faster", () => { // @spec AVATAR-ENG-015
  make({ smoothing: 0.2 });
  engine.prepare(utterance({ envelope: [1, 1, 1, 1], durationMs: 400 }));
  engine.play("u1", 0);
  frames(1);
  assert.ok(Math.abs(driver.last.mouthOpen - 0.6) < 1e-9); // rate = min(1, 0.2 * 3)
  assert.ok(Math.abs(driver.last.mouthSmile - 0.14) < 1e-9); // 0.7 target * 0.2
});

test("re-preparing a stored id makes it the newest, so a re-sent id is not evicted early", () => { // @spec AVATAR-ENG-002
  make();
  for (let i = 0; i < 50; i++) engine.prepare(utterance({ id: `u${i}`, gesture: "nod" }));
  engine.prepare(utterance({ id: "u0", gesture: "wave" })); // re-sent: now the newest
  engine.prepare(utterance({ id: "u50", gesture: "nod" })); // the 51st clause evicts the oldest, which is u1, not u0
  engine.play("u1", 0);
  assert.deepEqual(driver.gestures, [], "u1 was evicted");
  engine.play("u0", 0);
  assert.deepEqual(driver.gestures, ["wave"], "u0 survived with its replaced data");
});

test("neutral is never shown above intensity 0: held, as a mood and on decay", () => { // @spec AVATAR-ENG-017, AVATAR-ENG-008
  make();
  engine.setEmotion("neutral", 1000); // a held neutral line
  assert.deepEqual(driver.expressions, [["neutral", 0]]);
  engine.prepare(utterance({ emotion: "neutral" }));
  engine.play("u1", 0); // setEmotion through the utterance
  assert.deepEqual(driver.expressions.at(-1), ["neutral", 0]);
  engine.setMood("sad");
  engine.setMood("neutral");
  frames(60); // the hold expires: back to the resting mood
  assert.ok(driver.expressions.every(([e, i]) => e !== "neutral" || i === 0), JSON.stringify(driver.expressions));
  assert.deepEqual(states.at(-1), { emotion: "neutral", intensity: 0 });
});

test("a playing utterance is cleared once its envelope is spent and durationMs + 500 ms have passed, even without done", () => { // @spec AVATAR-ENG-006
  make({ idle_motion: true });
  const headX = (seconds: number) => 4 * Math.sin(seconds / 3.1) + 2 * Math.sin(seconds / 1.3); // the idle sway at t seconds since construction
  engine.prepare(utterance({ envelope: [0.5], envelopeHz: 10, durationMs: 100 }));
  engine.play("u1", 0);
  frames(1); // 100 ms in: envelope spent, still within durationMs + 500 ms
  assert.ok(Math.abs(driver.last.headX - 1.6 * headX(0.1)) < 1e-9, "playing: head sway amplified");
  frames(5); // 600 ms: not yet MORE than 600 ms
  assert.ok(Math.abs(driver.last.headX - 1.6 * headX(0.6)) < 1e-9, "still playing at exactly durationMs + 500");
  frames(1); // 700 ms
  assert.ok(Math.abs(driver.last.headX - headX(0.7)) < 1e-9, "cleared: sway back to normal");
});

// @spec AVATAR-ENG-002
test("clauses are keyed by id and seq: each clause of a line is stored on its own, and re-preparing one replaces only it", () => {
  make();
  engine.prepare(utterance({ seq: 0, envelope: [0.9], durationMs: 100 }));
  engine.prepare(utterance({ seq: 1, envelope: [0.3], durationMs: 100 }));
  engine.play("u1", 1);
  engine.prepare(utterance({ seq: 1, envelope: [0.5], durationMs: 100 })); // replaced
  engine.play("u1", 1);
  engine.play("u1", 2); // never prepared
  assert.equal(driver.expressions.length, 2, "seq 2 ignored");
});

// @spec AVATAR-ENG-002
test("the store holds 50 clauses of one line: the 51st evicts the least recently prepared, and re-prepare refreshes", () => {
  make();
  for (let s = 0; s < 50; s++) engine.prepare(utterance({ seq: s }));
  engine.prepare(utterance({ seq: 0, gesture: "wave" })); // refresh clause 0
  engine.prepare(utterance({ seq: 50 })); // evicts seq 1, not seq 0
  engine.play("u1", 1);
  assert.equal(driver.expressions.length, 0, "seq 1 evicted");
  engine.play("u1", 0);
  assert.equal(driver.expressions.length, 1, "seq 0 survived");
  assert.deepEqual(driver.gestures, ["wave"]);
});

// @spec AVATAR-ENG-003, AVATAR-ENG-007
test("a clause's lip-sync closes on its done and a later clause's play opens the mouth again from its own start", () => {
  make();
  engine.prepare(utterance({ seq: 0, envelope: [0.9, 0.9, 0.9], durationMs: 300 }));
  engine.prepare(utterance({ seq: 1, envelope: [0.7, 0.7, 0.7], durationMs: 300 }));
  engine.play("u1", 0);
  frames(1);
  assert.equal(driver.last.mouthOpen, 0.9);
  engine.done("u1", 0);
  frames(1);
  assert.equal(driver.last.mouthOpen, 0, "closed in the pause between clauses");
  engine.play("u1", 1);
  frames(1);
  assert.equal(driver.last.mouthOpen, 0.7);
});

// @spec AVATAR-ENG-007
test("done for a different clause of the same line has no effect on the playing clause", () => {
  make();
  engine.prepare(utterance({ seq: 0, envelope: [0.9, 0.9, 0.9, 0.9], durationMs: 400 }));
  engine.prepare(utterance({ seq: 1 }));
  engine.play("u1", 1 - 1);
  engine.done("u1", 1);
  frames(1);
  assert.equal(driver.last.mouthOpen, 0.9);
  engine.done("u1", 0);
  frames(1);
  assert.equal(driver.last.mouthOpen, 0);
});

// @spec AVATAR-ENG-005, AVATAR-ENG-003
test("a second play of the same clause restarts its envelope from that moment", () => {
  make();
  engine.prepare(utterance({ envelope: [0.1, 0.2, 0.3, 0.4], durationMs: 400 }));
  engine.play("u1", 0);
  frames(2);
  engine.play("u1", 0);
  frames(1);
  assert.equal(driver.last.mouthOpen, 0.2, "100 ms into the restarted envelope");
});

// @spec AVATAR-ENG-019
test("play extends the emotion hold to the later of the current end and durationMs + 4000 from now, never shortening it", () => {
  make();
  engine.setMood("sad"); // a non-neutral resting face: the expiry falls back to it at intensity 0.5
  engine.setEmotion("angry", 20_000); // a long hold already in force
  engine.prepare(utterance({ durationMs: 300, emotion: "happy" }));
  engine.play("u1", 0); // 4300 ms would shorten the 20 s hold: keeps 20 s
  frames(100); // 10 s: still held
  assert.equal(states.at(-1)!.intensity, 1);
  frames(101); // past 20 s
  assert.equal(states.at(-1)!.intensity, 0.5);
});

// @spec AVATAR-ENG-019
test("the hold set by the last clause outlasts the first clause's end", () => {
  make();
  engine.setMood("sad");
  engine.prepare(utterance({ seq: 0, durationMs: 1000 }));
  engine.prepare(utterance({ seq: 1, durationMs: 1000 }));
  engine.play("u1", 0); // end +5000
  frames(40);
  engine.play("u1", 1); // end +9000
  frames(46); // 8.6 s total, past the first end (5 s) but inside the second (9 s)
  assert.equal(states.at(-1)!.emotion, "happy");
  assert.equal(states.at(-1)!.intensity, 1);
});

// @spec AVATAR-ENG-020
test("play of a clause whose utterance has no gesture triggers none", () => {
  make();
  engine.prepare(utterance({ seq: 0 }));
  engine.play("u1", 0);
  assert.deepEqual(driver.gestures, []);
});

// @spec AVATAR-ENG-021
test("the gesture fires once per line, on seq 0 only: later clauses and a repeated play of seq 0 do not fire it", () => {
  make();
  engine.prepare(utterance({ seq: 0, gesture: "wave" }));
  engine.prepare(utterance({ seq: 1, gesture: "wave" })); // even if a later utterance carried one
  engine.play("u1", 0);
  engine.play("u1", 0); // a second sink's voice.playing for the same clause
  engine.play("u1", 1);
  assert.deepEqual(driver.gestures, ["wave"]);
});

// @spec AVATAR-ENG-021
test("a line whose seq 0 was never prepared fires no gesture from a later clause", () => {
  make();
  engine.prepare(utterance({ seq: 1, gesture: "wave" }));
  engine.play("u1", 1);
  assert.deepEqual(driver.gestures, []);
});

// @spec AVATAR-ENG-021
test("gesture memory is the newest 50 lines, separate from the 50-clause store", () => {
  make();
  engine.prepare(utterance({ id: "first", gesture: "wave" }));
  engine.play("first", 0);
  for (let i = 0; i < 50; i++) {
    engine.prepare(utterance({ id: `l${i}`, gesture: "nod" }));
    engine.play(`l${i}`, 0);
  }
  assert.equal(driver.gestures.length, 51);
  engine.prepare(utterance({ id: "first", gesture: "wave" })); // forgotten after 50 newer lines
  engine.play("first", 0);
  assert.equal(driver.gestures.length, 52, "the oldest line fired again once forgotten");
  engine.play("l49", 0);
  assert.equal(driver.gestures.length, 52, "a recent line is still remembered");
});
