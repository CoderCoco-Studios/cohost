// The avatar frame schema and decoder of src/avatar-frame.ts (BUS-AVF-002, BUS-AVF-008, BUS-AVF-011).
import { test } from "node:test";
import assert from "node:assert/strict";
import { AvatarFrameSchema, decodeAvatarFrame, type AvatarFrame } from "../src/avatar-frame.js";
import * as bus from "../src/index.js";

const good = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  mouthOpen: 0.5, mouthSmile: 0.25, headX: 10, headY: -10, headZ: 0, eyeX: 0.1, eyeY: -0.1, blink: 0,
  emotion: "happy", intensity: 0.8, expression: "", ...over,
});
const EMOTIONS = ["neutral", "happy", "laugh", "surprised", "smug", "sad", "angry", "confused", "think"];

// @spec BUS-AVF-011
test("@cohost/bus exports AvatarFrameSchema and decodeAvatarFrame from avatar-frame.ts, and the index re-exports them", () => {
  assert.equal(typeof AvatarFrameSchema.safeParse, "function");
  assert.equal(typeof decodeAvatarFrame, "function");
  assert.equal((bus as Record<string, unknown>).AvatarFrameSchema, AvatarFrameSchema);
  assert.equal((bus as Record<string, unknown>).decodeAvatarFrame, decodeAvatarFrame);
  const f: AvatarFrame = good() as unknown as AvatarFrame; // the type exists (erased at runtime; tsc checks it)
  void f;
});

// @spec BUS-AVF-002
test("a frame with every field in range is accepted, including the range ends, each of the nine emotions and a 64-char expression", () => {
  assert.ok(AvatarFrameSchema.safeParse(good()).success);
  assert.ok(AvatarFrameSchema.safeParse(good({
    mouthOpen: 0, mouthSmile: 1, intensity: 1, blink: 1, headX: -90, headY: 90, headZ: 90, eyeX: -1, eyeY: 1, expression: "x".repeat(64),
  })).success, "range ends and 64 characters");
  for (const emotion of EMOTIONS) assert.ok(AvatarFrameSchema.safeParse(good({ emotion })).success, emotion);
});

// @spec BUS-AVF-002
test("a value out of range, not finite or not a number is refused, per field", () => {
  const bad: [string, unknown[]][] = [
    ["mouthOpen", [-0.01, 1.01]], ["mouthSmile", [-0.01, 1.01]], ["intensity", [-0.01, 1.01]], ["blink", [-0.01, 1.01]],
    ["headX", [-90.01, 90.01]], ["headY", [-90.01, 90.01]], ["headZ", [-90.01, 90.01]],
    ["eyeX", [-1.01, 1.01]], ["eyeY", [-1.01, 1.01]],
  ];
  for (const [k, vs] of bad) for (const v of vs) assert.equal(AvatarFrameSchema.safeParse(good({ [k]: v })).success, false, `${k}=${String(v)}`);
  for (const k of ["mouthOpen", "mouthSmile", "intensity", "blink", "headX", "headY", "headZ", "eyeX", "eyeY"]) {
    for (const v of [NaN, Infinity, -Infinity, "0.5", null]) assert.equal(AvatarFrameSchema.safeParse(good({ [k]: v })).success, false, `${k}=${String(v)}`);
  }
});

// @spec BUS-AVF-002
test("an unknown emotion, an expression over 64 characters or a non-string expression is refused", () => {
  assert.equal(AvatarFrameSchema.safeParse(good({ emotion: "ecstatic" })).success, false);
  assert.equal(AvatarFrameSchema.safeParse(good({ emotion: "" })).success, false);
  assert.equal(AvatarFrameSchema.safeParse(good({ expression: "x".repeat(65) })).success, false);
  assert.equal(AvatarFrameSchema.safeParse(good({ expression: 3 })).success, false);
});

// @spec BUS-AVF-002
test("a missing field or an extra field is refused (no other field)", () => {
  for (const k of Object.keys(good())) {
    const f = good(); delete f[k];
    assert.equal(AvatarFrameSchema.safeParse(f).success, false, `missing ${k}`);
  }
  assert.equal(AvatarFrameSchema.safeParse(good({ extra: 1 })).success, false);
});

// @spec BUS-AVF-008, BUS-AVF-011
test("decodeAvatarFrame returns the frame for a good entry and null, never throwing, for a bad one", () => {
  const f = good();
  assert.deepEqual(decodeAvatarFrame(["ts", "1", "data", JSON.stringify(f)]), f);
  const bad: unknown[] = [
    ["ts", "1"], ["data", "{not json"], ["data", ""], ["ts", "1", "data", JSON.stringify(good({ mouthOpen: 2 }))],
    ["ts", "1", "data", JSON.stringify({ ...f, extra: 1 })], ["ts", "1", "data", "null"], ["ts", "1", "data", "[]"], [], null, undefined, "x", 3,
  ];
  for (const b of bad) assert.doesNotThrow(() => decodeAvatarFrame(b as never), JSON.stringify(b));
  for (const b of bad) assert.equal(decodeAvatarFrame(b as never), null, JSON.stringify(b));
  // the same on a Buffer-valued field list as xreadBuffer returns
  assert.deepEqual(decodeAvatarFrame([Buffer.from("ts"), Buffer.from("1"), Buffer.from("data"), Buffer.from(JSON.stringify(f))] as never), f);
});
