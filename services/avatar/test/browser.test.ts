import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadExpressions, type Emotion } from "@cohost/config";
import { AvatarFrameSchema, type AvatarFrame } from "@cohost/bus";
import { BrowserDriver } from "../src/drivers/browser.js";
import { NEUTRAL, type DriverContext } from "../src/types.js";

const EMOTIONS: Emotion[] = ["neutral", "happy", "laugh", "surprised", "smug", "sad", "angry", "confused", "think"];

/** A recording frame writer: each call is held until the test settles it, so a write can be left in flight. */
function writer() {
  const frames: AvatarFrame[] = [];
  const pending: { resolve: () => void; reject: (e: Error) => void }[] = [];
  const write = (f: AvatarFrame) => { frames.push(f); return new Promise<string>((resolve, reject) => pending.push({ resolve: () => resolve("1-0"), reject })); };
  return { frames, pending, write };
}
function setup(over: Partial<DriverContext> = {}) {
  const w = writer();
  const warnings: { msg: unknown; obj: unknown }[] = [];
  const log = { warn: (obj: unknown, msg?: unknown) => warnings.push({ obj, msg }), info() {}, error() {}, debug() {} } as never;
  const ctx = { log, stateDir: "/tmp", expressions: {}, gestures: {}, frames: Object.assign((f: AvatarFrame) => w.write(f), { publishAvatarFrame: w.write }), ...over } as unknown as DriverContext;
  return { w, ctx, warnings };
}
const tick = () => new Promise((r) => setImmediate(r));

// @spec AVATAR-BRW-001
test("the browser driver is named browser", () => {
  assert.equal(new BrowserDriver().name, "browser");
});

// @spec AVATAR-BRW-003
test("connect opens nothing, resolves at once and never rejects, even without a reachable bus", async () => {
  const { ctx } = setup({ frames: Object.assign(() => Promise.reject(new Error("redis down")), { publishAvatarFrame: () => Promise.reject(new Error("redis down")) }) as never });
  const d = new BrowserDriver();
  assert.equal(await Promise.race([d.connect(ctx).then(() => "done"), tick().then(() => "slow")]), "done");
});

// @spec AVATAR-BRW-004
test("setParams offers one frame: the eight parameters rounded to three decimals, the recorded emotion and intensity, and an expression", async () => {
  const { w, ctx } = setup();
  const d = new BrowserDriver();
  await d.connect(ctx);
  d.setParams({ mouthOpen: 0.123456, mouthSmile: 0.7, headX: 12.34567, headY: -3.0004, headZ: 0.0005, eyeX: -0.9996, eyeY: 0.5, blink: 1 });
  assert.equal(w.frames.length, 1);
  assert.deepEqual(w.frames[0], { mouthOpen: 0.123, mouthSmile: 0.7, headX: 12.346, headY: -3, headZ: 0.001, eyeX: -1, eyeY: 0.5, blink: 1, emotion: "neutral", intensity: 0, expression: "" });
  assert.equal(AvatarFrameSchema.safeParse(w.frames[0]).success, true, "a valid avatar frame (BUS-AVF-002)");
});

// @spec AVATAR-BRW-004, AVATAR-BRW-005
test("setExpression records the pair and writes nothing; the next frames carry it until it changes", async () => {
  const { w, ctx } = setup();
  const d = new BrowserDriver();
  await d.connect(ctx);
  d.setExpression("angry", 0.8);
  assert.equal(w.frames.length, 0, "setExpression writes nothing");
  d.setParams(NEUTRAL);
  assert.deepEqual([w.frames[0]!.emotion, w.frames[0]!.intensity], ["angry", 0.8]);
  w.pending[0]!.resolve(); await tick();
  d.setParams(NEUTRAL);
  assert.deepEqual([w.frames[1]!.emotion, w.frames[1]!.intensity], ["angry", 0.8]);
  w.pending[1]!.resolve(); await tick();
  d.setExpression("sad", 0.3);
  d.setParams(NEUTRAL);
  assert.deepEqual([w.frames[2]!.emotion, w.frames[2]!.intensity], ["sad", 0.3]);
});

// @spec AVATAR-BRW-006, AVATAR-BRW-007
test("with no browser block every emotion takes its built-in default, none for think and neutral", async () => {
  const want: Record<Emotion, string> = { happy: "happy", laugh: "happy", surprised: "surprised", smug: "relaxed", sad: "sad", angry: "angry", confused: "sad", think: "", neutral: "" };
  const { w, ctx } = setup();
  const d = new BrowserDriver();
  await d.connect(ctx);
  for (const e of EMOTIONS) {
    d.setExpression(e, 1);
    d.setParams(NEUTRAL);
    w.pending.at(-1)!.resolve(); await tick();
    assert.equal(w.frames.at(-1)!.expression, want[e], e);
  }
});

// @spec AVATAR-BRW-006
test("a block value overrides the default, an empty string means none, and an emotion the block lacks takes the default", async () => {
  const { w, ctx } = setup({ expressions: { happy: "Joy", sad: "", custom_unused: "x" } });
  const d = new BrowserDriver();
  await d.connect(ctx);
  const expr = async (e: Emotion, i: number) => { d.setExpression(e, i); d.setParams(NEUTRAL); w.pending.at(-1)!.resolve(); await tick(); return w.frames.at(-1)!.expression; };
  assert.equal(await expr("happy", 1), "Joy");
  assert.equal(await expr("sad", 1), "", "empty string: no expression, not the default");
  assert.equal(await expr("angry", 1), "angry", "key absent: built-in default");
});

// @spec AVATAR-BRW-006
test("expression is empty at an intensity of 0.05 or below and for neutral, even when the block maps neutral", async () => {
  const { w, ctx } = setup({ expressions: { happy: "Joy", neutral: "Calm" } });
  const d = new BrowserDriver();
  await d.connect(ctx);
  const expr = async (e: Emotion, i: number) => { d.setExpression(e, i); d.setParams(NEUTRAL); w.pending.at(-1)!.resolve(); await tick(); return w.frames.at(-1)!.expression; };
  assert.equal(await expr("happy", 0.05), "", "0.05 is not above 0.05");
  assert.equal(await expr("happy", 0.0501), "Joy");
  assert.equal(await expr("happy", 0), "");
  assert.equal(await expr("neutral", 1), "");
});

// @spec AVATAR-BRW-008
test("a frame offered while a write is in flight is dropped, not queued, and setParams never waits for a write", async () => {
  const { w, ctx } = setup();
  const d = new BrowserDriver();
  await d.connect(ctx);
  const t0 = performance.now();
  for (let i = 0; i < 5; i++) assert.equal(d.setParams({ ...NEUTRAL, headX: i }), undefined, "returns synchronously, not a promise");
  assert.ok(performance.now() - t0 < 100);
  assert.equal(w.frames.length, 1, "one write in flight; the other four were dropped");
  assert.equal(w.frames[0]!.headX, 0);
  w.pending[0]!.resolve(); await tick();
  assert.equal(w.frames.length, 1, "the dropped frames were not queued");
  d.setParams({ ...NEUTRAL, headX: 9 });
  assert.deepEqual(w.frames.map((f) => f.headX), [0, 9], "the next offer after the write settles is written");
});

// @spec AVATAR-BRW-008
test("a failed write also frees the slot so the next frame is written", async () => {
  const { w, ctx } = setup();
  const d = new BrowserDriver();
  await d.connect(ctx);
  d.setParams(NEUTRAL);
  w.pending[0]!.reject(new Error("boom")); await tick();
  d.setParams(NEUTRAL);
  assert.equal(w.frames.length, 2);
});

// @spec AVATAR-BRW-009
test("a failed write logs avatar frame publish failed at most once every 10 s on the monotonic clock and the driver keeps running", async () => {
  const { w, ctx, warnings } = setup();
  let now = 1_000_000;
  const clock = mock.method(performance, "now", () => now);
  const wall = mock.method(Date, "now", () => 0 + (now % 2) * 99_000); // a wall clock that jumps must not matter
  try {
    const d = new BrowserDriver();
    await d.connect(ctx);
    const failOne = async () => { d.setParams(NEUTRAL); w.pending.at(-1)!.reject(new Error("redis down")); await tick(); };
    await failOne();
    assert.equal(warnings.length, 1);
    assert.match(JSON.stringify(warnings[0]), /avatar frame publish failed/);
    now += 9_999; await failOne(); now += 1; // 9.999 s: still silent
    assert.equal(warnings.length, 1);
    await failOne(); // 10 s after the first log
    assert.equal(warnings.length, 2);
    const before = w.frames.length;
    d.setParams(NEUTRAL);
    assert.equal(w.frames.length, before + 1, "still writing after failures");
  } finally {
    clock.mock.restore();
    wall.mock.restore();
  }
});

// @spec AVATAR-BRW-009
test("a write that rejects without a handler never becomes an unhandled rejection", async () => {
  const { ctx } = setup({ frames: Object.assign(() => Promise.reject(new Error("down")), { publishAvatarFrame: () => Promise.reject(new Error("down")) }) as never });
  const uncaught: unknown[] = [];
  const on = (e: unknown) => { uncaught.push(e); };
  process.on("unhandledRejection", on);
  try {
    const d = new BrowserDriver();
    await d.connect(ctx);
    d.setParams(NEUTRAL);
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(uncaught, []);
  } finally { process.off("unhandledRejection", on); }
});

// @spec AVATAR-BRW-010
test("connected() is true from construction, false from a failed write until the next successful one", async () => {
  const { w, ctx } = setup();
  const d = new BrowserDriver();
  assert.equal(d.connected(), true, "from construction, before connect");
  await d.connect(ctx);
  assert.equal(d.connected(), true, "no page is needed");
  d.setParams(NEUTRAL);
  assert.equal(d.connected(), true, "a write in flight is not a failure");
  w.pending[0]!.reject(new Error("down")); await tick();
  assert.equal(d.connected(), false);
  d.setParams(NEUTRAL);
  assert.equal(d.connected(), false, "stays false while the retry is in flight");
  w.pending[1]!.resolve(); await tick();
  assert.equal(d.connected(), true);
});

// @spec AVATAR-BRW-011
test("trigger does nothing, whatever the gestures map holds", async () => {
  const { w, ctx } = setup({ gestures: { wave: "WAVE" } });
  const d = new BrowserDriver();
  await d.connect(ctx);
  assert.equal(d.trigger("wave"), undefined);
  assert.equal(w.frames.length, 0);
  d.setParams(NEUTRAL);
  assert.equal(w.frames.length, 1);
});

// @spec AVATAR-BRW-012
test("after disconnect no frame is written, and disconnect flushes nothing", async () => {
  const { w, ctx } = setup();
  const d = new BrowserDriver();
  await d.connect(ctx);
  await d.disconnect();
  d.setParams(NEUTRAL);
  assert.equal(w.frames.length, 0, "no frame after disconnect, and none flushed by disconnect");
  const { w: w2, ctx: ctx2 } = setup();
  const d2 = new BrowserDriver();
  await d2.connect(ctx2);
  d2.setParams(NEUTRAL); // one write in flight
  await d2.disconnect();
  assert.equal(w2.frames.length, 1, "disconnect wrote nothing more");
});

// @spec AVATAR-BRW-013
test("the shipped expressions.example.yaml holds a browser block with the nine emotions at the defaults and empty gestures", () => {
  const dir = mkdtempSync(join(tmpdir(), "cohost-expr-"));
  copyFileSync(new URL("../../../config/expressions.example.yaml", import.meta.url), join(dir, "expressions.example.yaml"));
  const prev = process.env.CONFIG_DIR;
  process.env.CONFIG_DIR = dir;
  try {
    const block = loadExpressions().browser;
    assert.ok(block, "a browser block");
    assert.deepEqual(block, { gestures: {}, happy: "happy", laugh: "happy", surprised: "surprised", smug: "relaxed", sad: "sad", angry: "angry", confused: "sad", think: "", neutral: "" });
  } finally {
    if (prev === undefined) delete process.env.CONFIG_DIR; else process.env.CONFIG_DIR = prev;
  }
});
