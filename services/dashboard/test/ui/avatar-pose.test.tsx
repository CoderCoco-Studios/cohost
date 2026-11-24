// Pure renderer modules of the avatar page (DASH-BUILD-011): frame validation, the frame-to-pose mapping and the
// expression write order. These import no DOM, WebGL or 3D-library module, so no GPU is needed. The modules under test
// do not exist yet: this file is the failing-first step of issue #218.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Emotion } from "@cohost/config";
import { eulerToQuat } from "@cohost/shared/head-rotation";
import { EMOTIONS, REST_FRAME, parseFrame } from "../../ui/src/avatar/frame";
import {
  armRestQuaternion,
  expressionWrites,
  gazeAngles,
  headQuaternion,
  presetName,
  smileWeight,
  type LookAtRanges,
} from "../../ui/src/avatar/pose";

const good = { mouthOpen: 0.4, mouthSmile: 0.7, headX: 10, headY: -5, headZ: 3, eyeX: 0.5, eyeY: -0.5, blink: 0.1, emotion: "happy", intensity: 0.6, expression: "" };
const close = (a: number, b: number, eps = 1e-9): void => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

// @spec DASH-AVP-030
test("the rest frame holds the documented rest values", () => {
  assert.deepEqual(REST_FRAME, { mouthOpen: 0, mouthSmile: 0.15, headX: 0, headY: 0, headZ: 0, eyeX: 0, eyeY: 0, blink: 0, emotion: "neutral", intensity: 0, expression: "" });
});

// @spec DASH-AVP-032
test("the page's emotion list is the bus's nine canonical emotions (the page may not import zod or config)", () => {
  assert.deepEqual([...EMOTIONS].sort(), [...Emotion.options].sort());
});

// @spec DASH-AVP-032
test("a valid frame is accepted, its unknown fields ignored (not copied) and boundary values allowed", () => {
  assert.deepEqual(parseFrame(good), good);
  assert.deepEqual(parseFrame({ ...good, extra: 1, constructor: "x" }), good);
  const edge = { ...good, mouthOpen: 1, mouthSmile: 0, headX: 90, headY: -90, headZ: 90, eyeX: -1, eyeY: 1, blink: 1, intensity: 0, expression: "x".repeat(64) };
  assert.deepEqual(parseFrame(edge), edge);
});

// @spec DASH-AVP-032
test("a frame with a missing field, a non-finite or non-number value, or a value out of range is dropped", () => {
  for (const k of Object.keys(good)) {
    const partial: Record<string, unknown> = { ...good };
    delete partial[k];
    assert.equal(parseFrame(partial), null, `missing ${k}`);
  }
  for (const k of ["mouthOpen", "mouthSmile", "headX", "headY", "headZ", "eyeX", "eyeY", "blink", "intensity"] as const) {
    for (const bad of [NaN, Infinity, -Infinity, "0.5", null, undefined, true, {}, []]) assert.equal(parseFrame({ ...good, [k]: bad }), null, `${k}=${String(bad)}`);
  }
  for (const [k, v] of [["mouthOpen", 1.01], ["mouthOpen", -0.01], ["mouthSmile", 2], ["blink", -1], ["intensity", 1.5], ["headX", 90.1], ["headY", -91], ["headZ", 200], ["eyeX", 1.1], ["eyeY", -1.1]] as const) {
    assert.equal(parseFrame({ ...good, [k]: v }), null, `${k}=${v}`);
  }
});

// @spec DASH-AVP-032
test("a frame with an unknown emotion, a non-string expression or an expression over 64 characters is dropped", () => {
  assert.equal(parseFrame({ ...good, emotion: "ecstatic" }), null);
  assert.equal(parseFrame({ ...good, emotion: "" }), null);
  assert.equal(parseFrame({ ...good, emotion: 3 }), null);
  assert.equal(parseFrame({ ...good, expression: 5 }), null);
  assert.equal(parseFrame({ ...good, expression: null }), null);
  assert.equal(parseFrame({ ...good, expression: "x".repeat(65) }), null);
  for (const e of EMOTIONS) assert.ok(parseFrame({ ...good, emotion: e }), e);
});

// @spec DASH-AVP-032
test("a frame that is not an object is dropped without throwing", () => {
  for (const v of [null, undefined, 0, "frame", [], [good], true]) assert.doesNotThrow(() => assert.equal(parseFrame(v), null));
});

// @spec DASH-AVP-012
test("the smile weight is clamp((mouthSmile - 0.15) / 0.85, 0, 1): rest shows nothing, the Engine's 0.7 shows (0.7 - 0.15) / 0.85", () => {
  close(smileWeight(0.15), 0);
  close(smileWeight(0), 0);
  close(smileWeight(0.7), (0.7 - 0.15) / 0.85); // 0.647..., the formula's exact value
  close(smileWeight(1), 1);
  close(smileWeight(0.575), 0.5);
  close(smileWeight(1.5), 1);
});

// @spec DASH-AVP-014
test("a VRM 1.0 head quaternion is [x, -y, -z, w] of eulerToQuat(headY, headX, headZ), pinned for a sample angle", () => {
  const q = eulerToQuat(20, 30, 10);
  const got = headQuaternion({ ...REST_FRAME, headX: 30, headY: 20, headZ: 10 }, "1.0");
  close(got[0], q[0]); close(got[1], -q[1]); close(got[2], -q[2]); close(got[3], q[3]);
  // Literals, so a change of eulerToQuat or of the conversion shows here (pitch = headY = 20, yaw = headX = 30, roll = headZ = 10).
  close(got[0], 0.1449, 1e-3); close(got[1], -0.2685, 1e-3); close(got[2], -0.0381, 1e-3); close(got[3], 0.9516, 1e-3);
});

// @spec DASH-AVP-015
test("a VRM 0.x head quaternion is [-x, -y, z, w] of the same quaternion", () => {
  const q = eulerToQuat(20, 30, 10);
  const got = headQuaternion({ ...REST_FRAME, headX: 30, headY: 20, headZ: 10 }, "0.x");
  close(got[0], -q[0]); close(got[1], -q[1]); close(got[2], q[2]); close(got[3], q[3]);
});

// @spec DASH-AVP-014
test("the whole angle goes to the head bone and the result is a unit quaternion; the rest frame is the identity", () => {
  for (const v of ["1.0", "0.x"] as const) {
    const [x, y, z, w] = headQuaternion({ ...REST_FRAME, headX: 60, headY: -45, headZ: 30 }, v);
    close(Math.hypot(x, y, z, w), 1);
    const [rx, ry, rz, rw] = headQuaternion(REST_FRAME, v);
    close(rx, 0); close(ry, 0); close(rz, 0); close(rw, 1);
  }
});

// @spec DASH-AVP-009
test("a VRM 0.x preset maps to its 1.0 name and a 0.x group with no preset keeps its own name", () => {
  const map: Record<string, string> = { neutral: "neutral", a: "aa", i: "ih", u: "ou", e: "ee", o: "oh", joy: "happy", angry: "angry", sorrow: "sad", fun: "relaxed", blink: "blink", blink_l: "blinkLeft", blink_r: "blinkRight", lookup: "lookUp", lookdown: "lookDown", lookleft: "lookLeft", lookright: "lookRight" };
  for (const [from, to] of Object.entries(map)) assert.equal(presetName(from), to, from);
  assert.equal(presetName("MyCustomGroup"), "MyCustomGroup");
  assert.equal(presetName(""), "");
});

// @spec DASH-AVP-009
test("a name that is already a 1.0 preset, or that is an Object.prototype property name, is not mistaken for a 0.x preset", () => {
  assert.equal(presetName("aa"), "aa");
  assert.equal(presetName("happy"), "happy");
  for (const n of ["constructor", "__proto__", "toString", "hasOwnProperty"]) assert.equal(presetName(n), n);
});

// @spec DASH-AVP-010, DASH-AVP-011
test("expression writes: an empty frame expression writes happy to the smile weight, then aa and blink", () => {
  const w = expressionWrites("", { ...REST_FRAME, mouthOpen: 0.4, blink: 0.1, mouthSmile: 0.7 });
  assert.deepEqual(w.map((x) => x.name), ["happy", "aa", "blink"]);
  close(w[0]!.weight, (0.7 - 0.15) / 0.85); assert.equal(w[1]!.weight, 0.4); assert.equal(w[2]!.weight, 0.1);
});

// @spec DASH-AVP-010
test("expression writes in order: the previous expression to 0, the new one to intensity, happy, aa, blink", () => {
  const w = expressionWrites("angry", { ...REST_FRAME, expression: "surprised", intensity: 0.8, mouthOpen: 0.2, blink: 0.3 });
  assert.deepEqual(w.map((x) => x.name), ["angry", "surprised", "happy", "aa", "blink"]);
  assert.deepEqual(w.map((x) => x.weight), [0, 0.8, 0, 0.2, 0.3]);
});

// @spec DASH-AVP-010
test("the previous expression is not zeroed when this frame names the same one, and is zeroed when this one is empty", () => {
  const same = expressionWrites("angry", { ...REST_FRAME, expression: "angry", intensity: 0.5 });
  assert.deepEqual(same.map((x) => x.name), ["angry", "happy", "aa", "blink"]);
  assert.equal(same[0]!.weight, 0.5);
  const empty = expressionWrites("angry", { ...REST_FRAME });
  assert.deepEqual(empty.slice(0, 2).map((x) => [x.name, x.weight]), [["angry", 0], ["happy", 0]]);
});

// @spec DASH-AVP-010
test("when the frame's expression is happy, happy takes the larger of the smile weight and intensity, never an earlier weight", () => {
  const big = expressionWrites("", { ...REST_FRAME, expression: "happy", intensity: 0.9, mouthSmile: 0.7 });
  assert.equal(big.filter((x) => x.name === "happy").at(-1)!.weight, 0.9);
  const small = expressionWrites("", { ...REST_FRAME, expression: "happy", intensity: 0.2, mouthSmile: 0.7 });
  close(small.filter((x) => x.name === "happy").at(-1)!.weight, (0.7 - 0.15) / 0.85);
  const after = expressionWrites("happy", { ...REST_FRAME, expression: "sad", intensity: 1, mouthSmile: 0.15 });
  assert.equal(after.filter((x) => x.name === "happy").at(-1)!.weight, 0);
});

// @spec DASH-AVP-010
test("aa and blink are written last, so the Engine's mouth and blink win over an expression named aa or blink", () => {
  const w = expressionWrites("", { ...REST_FRAME, expression: "aa", intensity: 1, mouthOpen: 0.25, blink: 0 });
  assert.equal(w.filter((x) => x.name === "aa").at(-1)!.weight, 0.25);
  const b = expressionWrites("", { ...REST_FRAME, expression: "blink", intensity: 1, blink: 0.5 });
  assert.equal(b.filter((x) => x.name === "blink").at(-1)!.weight, 0.5);
});

// @spec DASH-AVP-013
test("expressionWrites reports a model's own name as given, so the applier can skip a name the model lacks", () => {
  const w = expressionWrites("", { ...REST_FRAME, expression: "wink-custom", intensity: 1 });
  assert.ok(w.some((x) => x.name === "wink-custom" && x.weight === 1));
});

const ranges: LookAtRanges = { horizontalOuter: 40, verticalUp: 20, verticalDown: 10 };

// @spec DASH-AVP-016
test("gaze: yaw is eyeX times the horizontal outer inputMaxValue; pitch uses the up map for positive eyeY and the down map for negative", () => {
  const a = gazeAngles({ ...REST_FRAME, eyeX: 0.5, eyeY: 0.5 }, ranges)!;
  close(Math.abs(a.yaw), 20); close(Math.abs(a.pitch), 10);
  const b = gazeAngles({ ...REST_FRAME, eyeX: -0.5, eyeY: -0.5 }, ranges)!;
  close(Math.abs(b.yaw), 20); close(Math.abs(b.pitch), 5);
  close(a.yaw, -b.yaw);
  assert.ok(a.pitch > 0 && b.pitch < 0, "positive eyeY moves the gaze up and negative down");
  assert.deepEqual(gazeAngles({ ...REST_FRAME }, ranges), { yaw: 0, pitch: 0 });
});

// @spec DASH-AVP-016
test("a model with no look-at shows no gaze", () => {
  assert.equal(gazeAngles({ ...REST_FRAME, eyeX: 1, eyeY: 1 }, null), null);
});

// @spec DASH-AVP-018
test("arm rest pose: -65/+65 degrees about Z for the left/right upper arm of a 1.0 model, mirrored for a 0.x model", () => {
  const z = (deg: number): number[] => [0, 0, Math.sin((deg * Math.PI) / 360), Math.cos((deg * Math.PI) / 360)];
  const eq = (a: readonly number[], b: readonly number[]): void => b.forEach((v, i) => close(a[i]!, v));
  eq(armRestQuaternion("left", "1.0"), z(-65));
  eq(armRestQuaternion("right", "1.0"), z(65));
  eq(armRestQuaternion("left", "0.x"), z(65));
  eq(armRestQuaternion("right", "0.x"), z(-65));
});
