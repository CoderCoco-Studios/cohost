import { test } from "node:test";
import assert from "node:assert/strict";
import { runHeartbeat } from "@cohost/testing";
import { avatarHealth } from "../src/health.js";

test("null driver: mode off, driver n/a, still ready", async () => {
  const hbs = await runHeartbeat(avatarHealth({ name: "null", connected: () => true }));
  assert.equal(hbs[1]!.mode, "off");
  assert.deepEqual(hbs[1]!.deps, { driver: "n/a" });
  assert.equal(hbs[1]!.state, "ready");
});

test("real driver: live, driver ok iff connected", async () => {
  let up = true;
  const spec = avatarHealth({ name: "vmc", connected: () => up });
  assert.deepEqual((await runHeartbeat(spec))[1]!.deps, { driver: "ok" });
  up = false;
  const hbs = await runHeartbeat(spec);
  assert.equal(hbs[1]!.mode, "live");
  assert.deepEqual(hbs[1]!.deps, { driver: "down" });
  assert.equal(hbs[1]!.state, "degraded");
});
