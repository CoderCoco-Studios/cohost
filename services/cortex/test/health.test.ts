import { test } from "node:test";
import assert from "node:assert/strict";
import { runHeartbeat } from "@cohost/testing";
import { cortexHealth } from "../src/health.js";

test("ready when the llm answered ping", async () => {
  const hbs = await runHeartbeat(cortexHealth(() => true));
  assert.equal(hbs[1]!.service, "cortex");
  assert.equal(hbs[1]!.mode, "live");
  assert.deepEqual(hbs[1]!.deps, { llm: "ok" });
  assert.deepEqual(hbs.map((h) => h.state), ["starting", "ready", "stopping"]);
});

test("llm unreachable: dep down and state degraded", async () => {
  const hbs = await runHeartbeat(cortexHealth(() => false));
  assert.deepEqual(hbs[1]!.deps, { llm: "down" });
  assert.equal(hbs[1]!.state, "degraded");
});

test("mock provider: mode mock", async () => {
  const hbs = await runHeartbeat(cortexHealth(() => true, "mock"));
  assert.equal(hbs[1]!.mode, "mock");
});
