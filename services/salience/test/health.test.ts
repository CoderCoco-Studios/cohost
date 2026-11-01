import { test } from "node:test";
import assert from "node:assert/strict";
import { runHeartbeat } from "@cohost/testing";
import { salienceHealth } from "../src/health.js";

test("ready with no external deps; shutdown sends one stopping", async () => { // @spec SAL-HEALTH-001
  const hbs = await runHeartbeat(salienceHealth);
  assert.deepEqual(hbs.map((h) => h.state), ["starting", "ready", "stopping"]);
  assert.equal(hbs[1]!.service, "salience");
  assert.equal(hbs[1]!.mode, "live");
  assert.deepEqual(hbs[1]!.deps, {});
});
