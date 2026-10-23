import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import type { Emotion } from "@cohost/config";
import { Engine } from "../src/engine.js";
import type { AvatarDriver, AvatarParams, Capability } from "../src/types.js";

class FakeDriver implements AvatarDriver {
  readonly name = "fake";
  params: AvatarParams[] = [];
  expressions: [Emotion, number][] = [];
  gestures: string[] = [];
  capabilities(): ReadonlySet<Capability> { return new Set(); }
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
  ({ id: "u1", emotion: "happy" as Emotion, envelope: [0.8, 0.4, 0.2], envelopeHz: 10, durationMs: 300, ...over });

let driver: FakeDriver;
let states: { emotion: Emotion; intensity: number }[];
let engine: Engine;
const make = (over: Record<string, unknown> = {}) => {
  engine = new Engine(avatarCfg(over), driver, (_p, emotion, intensity) => states.push({ emotion, intensity }));
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

test("runs at cfg.fps and pushes params to the driver every frame", () => {
  make();
  frames(5);
  assert.equal(driver.params.length, 5);
  assert.equal(states.length, 5);
  engine.stop();
  frames(5);
  assert.equal(driver.params.length, 5);
});

test("lip-sync follows the envelope from when the sink starts playing, then closes", () => {
  make();
  engine.prepare(utterance());
  frames(1);
  assert.equal(driver.last.mouthOpen, 0); // prepared, not playing yet
  engine.play("u1");
  const mouth: number[] = [];
  for (let i = 0; i < 4; i++) { frames(1); mouth.push(driver.last.mouthOpen); }
  assert.deepEqual(mouth, [0.4, 0.2, 0, 0]); // 100ms in → envelope[1], ...; past the end → closed
});

test("play() sets the utterance emotion at full intensity and fires its gesture", () => {
  make();
  engine.prepare(utterance({ gesture: "wave" }));
  engine.play("u1");
  assert.deepEqual(driver.expressions, [["happy", 1]]);
  assert.deepEqual(driver.gestures, ["wave"]);
});

test("play() of an unknown or evicted id is ignored (only the last 20 are kept)", () => {
  make();
  for (let i = 0; i < 21; i++) engine.prepare(utterance({ id: `u${i}`, gesture: "nod" }));
  engine.play("u0");
  engine.play("nope");
  assert.equal(driver.expressions.length, 0);
  engine.play("u20");
  assert.deepEqual(driver.gestures, ["nod"]);
});

test("done() closes the mouth immediately; done() for another id does not", () => {
  make();
  engine.prepare(utterance({ envelope: [0.9, 0.9, 0.9, 0.9, 0.9], durationMs: 500 }));
  engine.play("u1");
  frames(1);
  engine.done("other");
  frames(1);
  assert.equal(driver.last.mouthOpen, 0.9);
  engine.done("u1");
  frames(1);
  assert.equal(driver.last.mouthOpen, 0);
});

test("a held emotion decays to the resting mood once its hold runs out", () => {
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

test("a mood change while an utterance holds the face waits for the hold to end", () => {
  make();
  engine.setEmotion("angry", 1000);
  engine.setMood("happy");
  assert.deepEqual(driver.expressions, [["angry", 1]]);
  engine.setMood("happy"); // same mood again is a no-op
  frames(11);
  assert.deepEqual(driver.expressions, [["angry", 1], ["happy", 0.5]]);
});

test("returning to a neutral mood clears the expression (intensity 0)", () => {
  make();
  engine.setMood("sad");
  engine.setMood("neutral");
  assert.deepEqual(driver.expressions.at(-1), ["neutral", 0]);
  frames(1);
  assert.deepEqual(states.at(-1), { emotion: "neutral", intensity: 0 });
});

test("smile follows the emotion", () => {
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

test("idle motion moves the head and eyes only when enabled", () => {
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

test("blinks: the first after ~3s, eyes shut briefly then open again", () => {
  make();
  frames(30); // up to and including t0 + 3000 ms
  assert.ok(driver.params.every((p) => p.blink === 0));
  frames(1);
  assert.equal(driver.last.blink, 1); // the 3100 ms frame is the first past nextBlink
  frames(2);
  assert.equal(driver.params.filter((p) => p.blink === 1).length, 2); // 120 ms spans the next 100 ms frame too
  assert.equal(driver.last.blink, 0);
});

test("smoothing eases the head, while the mouth moves 3x faster", () => {
  make({ smoothing: 0.2 });
  engine.prepare(utterance({ envelope: [1, 1, 1, 1], durationMs: 400 }));
  engine.play("u1");
  frames(1);
  assert.ok(Math.abs(driver.last.mouthOpen - 0.6) < 1e-9); // rate = min(1, 0.2 * 3)
  assert.ok(Math.abs(driver.last.mouthSmile - 0.14) < 1e-9); // 0.7 target * 0.2
});
