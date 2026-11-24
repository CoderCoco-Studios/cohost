// Pure renderer modules of the avatar page, part two (DASH-BUILD-011): hold-and-ease, framing arithmetic, canvas fit,
// reconnect schedule and the context-loss reload backoff. Failing-first step of issue #218: the modules do not exist yet.
import { test } from "node:test";
import assert from "node:assert/strict";
import { REST_FRAME } from "../../ui/src/avatar/frame";
import { poseAt, HOLD_MS, EASE_MS } from "../../ui/src/avatar/ease";
import { canvasSize, clampStepSeconds, DEFAULT_BOX, framingPlan, MAX_STEP_MS } from "../../ui/src/avatar/framing";
import { createReconnect } from "../../ui/src/avatar/reconnect";
import { contextLossWait } from "../../ui/src/avatar/context-loss";
import { FakeStorage } from "./helpers/fakes";

const close = (a: number, b: number, eps = 1e-9): void => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);
const frame = { mouthOpen: 0.8, mouthSmile: 0.95, headX: 40, headY: -20, headZ: 10, eyeX: 1, eyeY: -1, blink: 1, emotion: "happy" as const, intensity: 1, expression: "surprised" };

// @spec DASH-AVP-030
test("before any frame the page draws the rest values", () => {
  assert.deepEqual(poseAt(null, 12345), REST_FRAME);
});

// @spec DASH-AVP-030
test("the last pose is held exactly 2 s from the arrival of the last valid frame", () => {
  assert.equal(HOLD_MS, 2000);
  assert.equal(EASE_MS, 1000);
  assert.deepEqual(poseAt({ frame, at: 1000 }, 1000), frame);
  assert.deepEqual(poseAt({ frame, at: 1000 }, 2999), frame);
  assert.deepEqual(poseAt({ frame, at: 1000 }, 3000), frame); // exactly 2 s: the ease starts here, at its first instant
});

// @spec DASH-AVP-030
test("over the next second each parameter moves in a straight line to its rest value and the intensity to 0", () => {
  const half = poseAt({ frame, at: 0 }, 2500);
  close(half.mouthOpen, 0.4); close(half.mouthSmile, 0.55); close(half.headX, 20); close(half.headY, -10); close(half.headZ, 5);
  close(half.eyeX, 0.5); close(half.eyeY, -0.5); close(half.blink, 0.5); close(half.intensity, 0.5);
  assert.equal(half.expression, "surprised", "the expression stays, at a lower intensity, until the end");
  const quarter = poseAt({ frame, at: 0 }, 2250);
  close(quarter.mouthOpen, 0.6); close(quarter.intensity, 0.75);
});

// @spec DASH-AVP-030
test("at the end of the ease the rest values show, with no expression, and stay there", () => {
  for (const t of [3000, 3001, 60_000]) {
    const p = poseAt({ frame, at: 0 }, t);
    assert.equal(p.mouthOpen, 0); assert.equal(p.mouthSmile, 0.15); assert.equal(p.headX, 0); assert.equal(p.eyeY, 0);
    assert.equal(p.blink, 0); assert.equal(p.intensity, 0); assert.equal(p.expression, "");
  }
});

// @spec DASH-AVP-030
test("a valid frame after the ease is applied at once, with no ramp", () => {
  const next = { ...frame, headX: -30 };
  assert.deepEqual(poseAt({ frame: next, at: 10_000 }, 10_000), next);
});

// @spec DASH-AVP-030
test("a clock that steps backwards cannot push the pose past the held frame", () => {
  assert.deepEqual(poseAt({ frame, at: 5000 }, 4000), frame);
});

const box = { min: [-0.5, 0, -0.2] as [number, number, number], max: [0.5, 1.6, 0.2] as [number, number, number] };

// @spec DASH-AVP-021
test("framing: 30 degree camera at the box middle; frame height 1.05 x box height at the target distance", () => {
  const p = framingPlan(box, { zoom: 1, offsetY: 0, turn: 0 });
  assert.equal(p.fov, 30);
  assert.deepEqual(p.target, [0, 0.8, 0]);
  const frameHeight = 1.05 * 1.6;
  const distance = frameHeight / (2 * Math.tan((15 * Math.PI) / 180));
  close(p.frameHeight, frameHeight);
  close(p.camera[2] - p.target[2], distance, 1e-6); // in front, on the model's +Z side
  close(p.camera[0], 0); close(p.camera[1], 0.8);
  assert.equal(p.modelOffsetY, 0);
  assert.equal(p.modelRotationY, 0);
});

// @spec DASH-AVP-021
test("framing: zoom divides the frame height (2 is twice as close), offsetY moves the model up by that many frame heights", () => {
  const p = framingPlan(box, { zoom: 2, offsetY: -0.25, turn: 0 });
  close(p.frameHeight, (1.05 * 1.6) / 2);
  close(p.modelOffsetY, -0.25 * p.frameHeight);
  const up = framingPlan(box, { zoom: 1, offsetY: 0.5, turn: 0 });
  assert.ok(up.modelOffsetY > 0, "positive offsetY moves the model up the frame");
  const near = framingPlan(box, { zoom: 2, offsetY: 0, turn: 0 });
  const far = framingPlan(box, { zoom: 1, offsetY: 0, turn: 0 });
  close(far.camera[2] - far.target[2], 2 * (near.camera[2] - near.target[2]), 1e-6);
});

// @spec DASH-AVP-021
test("framing: turn rotates the model about the vertical axis through the box centre; positive turns its front toward the viewer's right", () => {
  const p = framingPlan(box, { zoom: 1, offsetY: 0, turn: 90 });
  close(p.modelRotationY, Math.PI / 2);
  assert.deepEqual(p.pivot, [0, 0.8, 0]);
  // A model facing +Z, rotated +90 degrees about +Y, faces +X: the right of a viewer looking down -Z from +Z.
  const [fx, , fz] = [Math.sin(p.modelRotationY), 0, Math.cos(p.modelRotationY)];
  close(fx, 1); close(fz, 0, 1e-12);
  close(framingPlan(box, { zoom: 1, offsetY: 0, turn: -45 }).modelRotationY, -Math.PI / 4);
});

// @spec DASH-AVP-021
test("framing: an off-centre bounding box moves the target, camera and pivot with its middle", () => {
  const p = framingPlan({ min: [1, 2, 3], max: [3, 6, 5] }, { zoom: 1, offsetY: 0, turn: 0 });
  assert.deepEqual(p.target, [2, 4, 4]);
  assert.deepEqual(p.pivot, [2, 4, 4]);
  close(p.frameHeight, 1.05 * 4);
});

// @spec DASH-AVP-021
test("framing: a degenerate box (zero height) or a non-positive zoom yields a finite plan rather than NaN or Infinity", () => {
  for (const [b, z] of [[{ min: [0, 0, 0], max: [1, 0, 1] }, 1], [box, 0], [box, -2], [box, Number.NaN]] as const) {
    const p = framingPlan(b as typeof box, { zoom: z, offsetY: 0, turn: 0 });
    for (const n of [p.frameHeight, ...p.camera, ...p.target]) assert.ok(Number.isFinite(n), JSON.stringify(p));
  }
});

// @spec DASH-AVP-007
test("the canvas is the window size at the device pixel ratio capped at 2", () => {
  assert.deepEqual(canvasSize({ width: 1280, height: 720, devicePixelRatio: 1 }), { width: 1280, height: 720, pixelRatio: 1 });
  assert.equal(canvasSize({ width: 1280, height: 720, devicePixelRatio: 1.5 }).pixelRatio, 1.5);
  assert.equal(canvasSize({ width: 1280, height: 720, devicePixelRatio: 2 }).pixelRatio, 2);
  assert.equal(canvasSize({ width: 1280, height: 720, devicePixelRatio: 3 }).pixelRatio, 2);
  assert.equal(canvasSize({ width: 1280, height: 720, devicePixelRatio: 0 }).pixelRatio, 1, "a zero or absent ratio falls back to 1");
  assert.equal(canvasSize({ width: 0, height: 0, devicePixelRatio: 1 }).width, 1, "a zero-size window never makes a zero-size canvas");
});

// @spec DASH-AVP-019
test("spring bones step with the time since the last draw, clamped to 50 ms", () => {
  assert.equal(MAX_STEP_MS, 50);
  close(clampStepSeconds(16), 0.016);
  close(clampStepSeconds(50), 0.05);
  close(clampStepSeconds(5000), 0.05);
  assert.equal(clampStepSeconds(-5), 0);
  assert.equal(clampStepSeconds(Number.NaN), 0);
});

// @spec DASH-AVP-033
test("reconnect: 1 s, doubling per consecutive close of a connection that did not stay open 10 s, up to 10 s", () => {
  const r = createReconnect();
  assert.deepEqual([0, 0, 0, 0, 0, 0].map(() => r.onClose(0)), [1000, 2000, 4000, 8000, 10_000, 10_000]);
});

// @spec DASH-AVP-033
test("reconnect: a refused upgrade is a close of a connection that was never open and counts as a failure", () => {
  const r = createReconnect();
  assert.equal(r.onClose(null), 1000);
  assert.equal(r.onClose(null), 2000);
});

// @spec DASH-AVP-033
test("reconnect: a connection open for 10 s resets the delay to 1 s; one open 9.999 s does not", () => {
  const r = createReconnect();
  r.onClose(0); r.onClose(0); r.onClose(0);
  assert.equal(r.onClose(10_000), 1000);
  assert.equal(r.onClose(0), 2000);
  assert.equal(r.onClose(9_999), 4000);
  assert.equal(r.onClose(60_000), 1000);
});

// @spec DASH-AVP-034
test("context loss: first wait is 10 s; a further loss within 60 s of the last reload waits twice as long, up to 60 s", () => {
  const s = new FakeStorage();
  let t = 1_000_000;
  const waits: number[] = [];
  for (let i = 0; i < 6; i++) { const w = contextLossWait(s, t); waits.push(w); t += w + 5_000; } // reload after the wait, lost again 5 s later
  assert.deepEqual(waits, [10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
});

// @spec DASH-AVP-034
test("context loss: a loss more than 60 s after the last reload starts again at 10 s", () => {
  const s = new FakeStorage();
  const t = 5_000_000;
  assert.equal(contextLossWait(s, t), 10_000);
  assert.equal(contextLossWait(s, t + 10_000 + 61_000), 10_000);
});

// @spec DASH-AVP-034
test("context loss: where sessionStorage throws or holds garbage, the wait is 10 s and nothing throws", () => {
  assert.equal(contextLossWait(FakeStorage.throwing(), 1), 10_000);
  // A storage that answers every key with the same stored text, whatever key the implementation chose.
  const holding = (text: string): Pick<Storage, "getItem" | "setItem"> => ({ getItem: () => text, setItem: () => undefined });
  for (const v of ["{not json", "null", "[]", "42", '{"at":"x","wait":-5}', '{"at":1,"wait":1e999}', '{"at":null,"wait":null}']) {
    assert.equal(contextLossWait(holding(v), 2), 10_000, v);
  }
});

// @spec DASH-AVP-034
test("a stored wait below 10 s never gives a reload sooner than 10 s", () => {
  const holding = (text: string): Pick<Storage, "getItem" | "setItem"> => ({ getItem: () => text, setItem: () => undefined });
  assert.equal(contextLossWait(holding('{"at":2,"wait":1e-9}'), 2), 10_000);
  assert.equal(contextLossWait(holding('{"at":2,"wait":0.5}'), 2), 10_000);
});

// @spec DASH-AVP-021
test("a box with no geometry (infinite extent, or a zero-height box) frames the default box, so the plan is finite", () => {
  const none = { min: [Infinity, Infinity, Infinity] as [number, number, number], max: [-Infinity, -Infinity, -Infinity] as [number, number, number] };
  const flat = { min: [0, 0, 0] as [number, number, number], max: [1, 0, 1] as [number, number, number] };
  const dflt = framingPlan(DEFAULT_BOX, { zoom: 1, offsetY: 0, turn: 0 });
  assert.deepEqual(framingPlan(none, { zoom: 1, offsetY: 0, turn: 0 }), dflt);
  assert.deepEqual(framingPlan(flat, { zoom: 1, offsetY: 0, turn: 0 }), dflt);
});
