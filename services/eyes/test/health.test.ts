import { test } from "node:test";
import assert from "node:assert/strict";
import { runHeartbeat } from "@cohost/testing";
import { EyesHealth } from "../src/health.js";

// @spec EYES-HEALTH-001
test("vision disabled: mode off and both deps n/a", async () => {
  const hbs = await runHeartbeat(new EyesHealth(false, () => false).spec);
  assert.equal(hbs[1]!.mode, "off");
  assert.deepEqual(hbs[1]!.deps, { obs: "n/a", ollama: "n/a" });
  assert.equal(hbs[1]!.state, "ready");
});

// @spec EYES-HEALTH-002, EYES-HEALTH-003, EYES-HEALTH-004
test("enabled: obs follows the connection, ollama follows describe calls", async () => {
  let obs = true;
  const h = new EyesHealth(true, () => obs);
  assert.deepEqual((await runHeartbeat(h.spec))[1]!.deps, { obs: "ok", ollama: "ok" });
  await assert.rejects(h.track(async () => { throw new Error("boom"); })("b64", ""));
  obs = false;
  const hbs = await runHeartbeat(h.spec);
  assert.deepEqual(hbs[1]!.deps, { obs: "down", ollama: "down" });
  assert.equal(hbs[1]!.state, "degraded");
  assert.equal(hbs[1]!.mode, "live");
});

// @spec EYES-STUB-002
test("stub engine: mode mock with ollama n/a while enabled, mode off when vision is disabled", async () => {
  const on = await runHeartbeat(new EyesHealth(true, () => true, "stub").spec);
  assert.equal(on[1]!.mode, "mock");
  assert.deepEqual(on[1]!.deps, { obs: "ok", ollama: "n/a" });
  assert.equal(on[1]!.state, "ready");
  const off = await runHeartbeat(new EyesHealth(false, () => false, "stub").spec);
  assert.equal(off[1]!.mode, "off");
  assert.deepEqual(off[1]!.deps, { obs: "n/a", ollama: "n/a" });
});

// @spec EYES-HEALTH-003
test("ollama recovers to ok after a successful describe following a failure", async () => {
  const h = new EyesHealth(true, () => true);
  await assert.rejects(h.track(async () => { throw new Error("boom"); })("b64", ""));
  assert.equal((await runHeartbeat(h.spec))[1]!.deps!.ollama, "down");
  await h.track(async () => "fine")("b64", "");
  const hbs = await runHeartbeat(h.spec);
  assert.equal(hbs[1]!.deps!.ollama, "ok");
  assert.equal(hbs[1]!.state, "ready");
});
