import { test } from "node:test";
import assert from "node:assert/strict";
import { runHeartbeat } from "@cohost/testing";
import { affectHealth } from "../src/health.js";

test("ready with no external deps; shutdown sends one stopping", async () => {
  const hbs = await runHeartbeat(affectHealth);
  assert.deepEqual(hbs.map((h) => h.state), ["starting", "ready", "stopping"]);
  assert.equal(hbs[1]!.service, "affect");
  assert.equal(hbs[1]!.mode, "live");
  assert.deepEqual(hbs[1]!.deps, {});
});
