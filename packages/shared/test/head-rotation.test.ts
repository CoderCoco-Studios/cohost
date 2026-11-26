import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = new URL("../src/head-rotation.ts", import.meta.url);
const PKG = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { exports: Record<string, unknown> };

// @spec SHARED-ROT-001
test("the package exports the head-rotation subpath, mapped to its built module and declarations, and it resolves", async () => {
  assert.deepEqual(PKG.exports["./head-rotation"], { types: "./dist/head-rotation.d.ts", default: "./dist/head-rotation.js" });
  assert.ok("." in PKG.exports && "./untrusted" in PKG.exports, "beside the main entry and the other subpaths");
  const mod = await import("@cohost/shared/head-rotation");
  assert.equal(typeof mod.eulerToQuat, "function");
});

// @spec SHARED-ROT-002
test("the head-rotation source imports nothing, performs no I/O and reads no clock", () => {
  const code = readFileSync(SRC, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(code, /^\s*import\b|\bimport\s*\(|\brequire\s*\(|\bfrom\s+["']/m, "no import of any kind");
  assert.doesNotMatch(code, /\b(Date|performance|process|Buffer|setTimeout|fetch|console|Math\.random)\b/, "no clock, I/O or host global");
});

// @spec SHARED-ROT-003
test("eulerToQuat(0, 0, 0) is the identity and a single axis gives sin and cos of half the angle", async () => {
  const { eulerToQuat } = await import("@cohost/shared/head-rotation");
  assert.deepEqual(eulerToQuat(0, 0, 0), [0, 0, 0, 1]);
  const h = Math.SQRT1_2;
  const near = (got: number[], want: number[]) => got.forEach((v, i) => assert.ok(Math.abs(v - want[i]!) < 1e-12, `${got.join(",")} vs ${want.join(",")}`));
  near(eulerToQuat(90, 0, 0), [h, 0, 0, h]); // pitch -> x
  near(eulerToQuat(0, 90, 0), [0, h, 0, h]); // yaw -> y
  near(eulerToQuat(0, 0, 90), [0, 0, h, h]); // roll -> z
});

// @spec SHARED-ROT-003
test("eulerToQuat pins the stated formula for a mixed angle", async () => {
  const { eulerToQuat } = await import("@cohost/shared/head-rotation");
  const r = Math.PI / 180;
  const [p, y, o] = [20, -35, 50];
  const [cp, sp, cy, sy, cr, sr] = [Math.cos(p * r / 2), Math.sin(p * r / 2), Math.cos(y * r / 2), Math.sin(y * r / 2), Math.cos(o * r / 2), Math.sin(o * r / 2)];
  const want = [sp * cy * cr - cp * sy * sr, cp * sy * cr + sp * cy * sr, cp * cy * sr - sp * sy * cr, cp * cy * cr + sp * sy * sr];
  const got = eulerToQuat(p, y, o);
  want.forEach((v, i) => assert.ok(Math.abs(got[i]! - v) < 1e-12));
  assert.ok(Math.abs(got.reduce((s, v) => s + v * v, 0) - 1) < 1e-12, "a unit quaternion");
});
