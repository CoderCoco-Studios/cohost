import { test } from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import { readFileSync, readdirSync } from "node:fs";
import { eulerToQuat } from "@cohost/shared/head-rotation";
import { VmcDriver } from "../src/drivers/vmc.js";
import { NEUTRAL, type DriverContext } from "../src/types.js";

const log = { warn() {}, info() {}, error() {}, debug() {} } as never;
const ctx = (): DriverContext => ({ log, stateDir: "/tmp", expressions: {}, gestures: {} });

/** The head quaternion `[x, y, z, w]` a VMC driver sends for one parameter set. */
async function headQuat(p: Partial<typeof NEUTRAL>): Promise<[number, number, number, number]> {
  const sock = dgram.createSocket("udp4");
  const heads: [number, number, number, number][] = [];
  sock.on("message", (b) => {
    if (!b.toString("latin1", 0, 20).startsWith("/VMC/Ext/Bone/Pos")) return;
    const f = (i: number) => b.readFloatBE(b.length - 4 * (8 - i)); // the last four floats are x y z w
    heads.push([f(4), f(5), f(6), f(7)]);
  });
  await new Promise<void>((r) => sock.bind(0, "127.0.0.1", r));
  const d = new VmcDriver({ host: "127.0.0.1", port: sock.address().port });
  await d.connect(ctx());
  d.setParams({ ...NEUTRAL, ...p });
  const t0 = performance.now();
  while (heads.length === 0 && performance.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 5));
  await d.disconnect();
  sock.close();
  assert.equal(heads.length > 0, true, "a head bone message arrived");
  return heads[0]!;
}

// @spec AVATAR-VMC-007
test("vmc: the head quaternion comes from the shared eulerToQuat(headY, headX, headZ) and the driver keeps no copy", async () => {
  const src = readFileSync(new URL("../src/drivers/vmc.ts", import.meta.url), "utf8");
  assert.match(src, /import\s*\{[^}]*\beulerToQuat\b[^}]*\}\s*from\s*"@cohost\/shared\/head-rotation"/);
  assert.doesNotMatch(src, /function\s+eulerToQuat|const\s+eulerToQuat/, "no local copy of the conversion");
  const q = await headQuat({ headX: 12, headY: -7, headZ: 21 });
  const want = eulerToQuat(-7, 12, 21);
  q.forEach((v, i) => assert.ok(Math.abs(v - want[i]!) < 1e-6, `component ${i}: ${v} vs ${want[i]}`));
});

// The quaternion is read in the left-handed space VMC receivers use, for a model that faces the viewer (avatar design,
// Direction of the angles): a positive rotation about +Y turns the face toward the viewer's left, about +X tips it
// down, about +Z tilts the top of the head toward the viewer's right.

// @spec AVATAR-DIR-001
test("a positive headX is a positive yaw: the y component of the head quaternion is positive and the others are zero", async () => {
  const [x, y, z, w] = await headQuat({ headX: 20 });
  assert.ok(y > 0.1 && Math.abs(x) < 1e-6 && Math.abs(z) < 1e-6 && w > 0);
});

// @spec AVATAR-DIR-002
test("a positive headY is a positive pitch: the x component of the head quaternion is positive and the others are zero", async () => {
  const [x, y, z, w] = await headQuat({ headY: 20 });
  assert.ok(x > 0.1 && Math.abs(y) < 1e-6 && Math.abs(z) < 1e-6 && w > 0);
});

// @spec AVATAR-DIR-003
test("a positive headZ is a positive roll: the z component of the head quaternion is positive and the others are zero", async () => {
  const [x, y, z, w] = await headQuat({ headZ: 20 });
  assert.ok(z > 0.1 && Math.abs(x) < 1e-6 && Math.abs(y) < 1e-6 && w > 0);
});

// @spec AVATAR-DIR-001, AVATAR-DIR-002, AVATAR-DIR-003, AVATAR-DIR-004, AVATAR-DIR-005
test("the five directions are stated in the avatar service's code comments", () => {
  const dirs = [new URL("../src/", import.meta.url), new URL("../src/drivers/", import.meta.url)];
  const code = dirs.flatMap((d) => readdirSync(d).filter((f) => f.endsWith(".ts")).map((f) => readFileSync(new URL(f, d), "utf8"))).join("\n");
  assert.match(code, /headX[^\n]*viewer's left/i);
  assert.match(code, /headY[^\n]*(chin|down)/i);
  assert.match(code, /headZ[^\n]*viewer's right/i);
  assert.match(code, /eyeX[^\n]*viewer's right/i);
  assert.match(code, /eyeY[^\n]*\bup\b/i);
});
