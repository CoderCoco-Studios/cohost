import { test } from "node:test";
import assert from "node:assert/strict";
import { runHeartbeat } from "@cohost/testing";
import { cortexHealth } from "../src/health.js";

// @spec CTX-HEALTH-001, CTX-HEALTH-002
test("ready when the llm answered ping", async () => {
  const hbs = await runHeartbeat(cortexHealth(() => true));
  assert.equal(hbs[1]!.service, "cortex");
  assert.equal(hbs[1]!.mode, "live");
  assert.deepEqual(hbs[1]!.deps, { llm: "ok" });
  assert.deepEqual(hbs.map((h) => h.state), ["starting", "ready", "stopping"]);
});

// @spec CTX-HEALTH-002
test("llm unreachable: dep down and state degraded", async () => {
  const hbs = await runHeartbeat(cortexHealth(() => false));
  assert.deepEqual(hbs[1]!.deps, { llm: "down" });
  assert.equal(hbs[1]!.state, "degraded");
});

// @spec CTX-HEALTH-001
test("mock provider: mode mock", async () => {
  const hbs = await runHeartbeat(cortexHealth(() => true, "mock"));
  assert.equal(hbs[1]!.mode, "mock");
});

// @spec CTX-HEALTH-003
test("llm status follows the supplied outcome: down after a failed reply, ok again after recovery", async () => {
  let ok = true;
  const spec = cortexHealth(() => ok);
  assert.deepEqual((await runHeartbeat(spec))[1]!.deps, { llm: "ok" });
  ok = false;
  const down = await runHeartbeat(spec);
  assert.equal(down[1]!.state, "degraded");
  ok = true;
  assert.deepEqual((await runHeartbeat(spec))[1]!.deps, { llm: "ok" });
});

// @spec CTX-HEALTH-004
test("a provider whose ping is nominal reports llm n/a (not probed) until a reply outcome arrives, and stays ready", async () => {
  let probed = false;
  const spec = cortexHealth(() => true, "bedrock", () => probed);
  const before = await runHeartbeat(spec);
  assert.deepEqual([before[1]!.state, before[1]!.deps], ["ready", { llm: "n/a" }]);
  probed = true;
  assert.deepEqual((await runHeartbeat(spec))[1]!.deps, { llm: "ok" });
});

// @spec CTX-HEALTH-004
test("a nominal-ping provider states in the heartbeat detail that llm is not probed; others carry no detail", async () => {
  const nominal = await runHeartbeat(cortexHealth(() => true, "bedrock", () => false, true));
  assert.equal(nominal[1]!.state, "ready");
  assert.match(nominal[1]!.detail ?? "", /llm.*not probed/i);
  const normal = await runHeartbeat(cortexHealth(() => true, "ollama"));
  assert.equal(normal[1]!.detail, undefined);
});

// @spec CTX-HEALTH-004
test("a down llm dependency still reports its own detail over the not-probed note", async () => {
  const hbs = await runHeartbeat(cortexHealth(() => false, "bedrock", () => true, true));
  assert.equal(hbs[1]!.state, "degraded");
  assert.match(hbs[1]!.detail ?? "", /dependency down: llm/);
});
