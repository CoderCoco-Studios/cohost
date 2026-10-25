import { test } from "node:test";
import assert from "node:assert/strict";
import { runHeartbeat } from "@cohost/testing";
import { EyesHealth, eyesPlan } from "../src/health.js";

test("vision disabled: mode off and both deps n/a", async () => {
  const hbs = await runHeartbeat(new EyesHealth(false, () => false).spec);
  assert.equal(hbs[1]!.mode, "off");
  assert.deepEqual(hbs[1]!.deps, { obs: "n/a", ollama: "n/a" });
  assert.equal(hbs[1]!.state, "ready");
});

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

test("eyesPlan: disabled vision idles (no OBS connect loop); enabled runs", () => {
  assert.equal(eyesPlan({ enabled: false }), "idle");
  assert.equal(eyesPlan({ enabled: true }), "run");
});
