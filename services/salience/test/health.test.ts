import { test } from "node:test";
import assert from "node:assert/strict";
import { runHeartbeat, testConfig } from "@cohost/testing";
import { salienceHealth } from "../src/health.js";

test("ready with no external deps; shutdown sends one stopping", async () => { // @spec SAL-HEALTH-001
  const hbs = await runHeartbeat(salienceHealth(testConfig()));
  assert.deepEqual(hbs.map((h) => h.state), ["starting", "ready", "stopping"]);
  assert.equal(hbs[1]!.service, "salience");
  assert.equal(hbs[1]!.mode, "live");
  assert.deepEqual(hbs[1]!.deps, {});
});

test("mode is mock only when the scorer is an llm hook that inherits the mock provider", () => { // @spec SAL-HEALTH-005
  const mode = (over: Record<string, unknown>) => salienceHealth(testConfig(over)).mode;
  assert.equal(mode({ llm: { provider: "mock" } }), "live", "rules scorer: no model is called");
  assert.equal(mode({ llm: { provider: "mock" }, brain: { salience: { module: { kind: "llm" } } } }), "mock");
  assert.equal(mode({ llm: { provider: "ollama" }, brain: { salience: { module: { kind: "llm" } } } }), "live");
  assert.equal(
    mode({ llm: { provider: "mock" }, brain: { salience: { module: { kind: "llm", llm: { provider: "ollama", model: "small" } } } } }),
    "live",
    "the hook overrides the provider",
  );
  assert.equal(mode({ llm: { provider: "mock" }, brain: { salience: { module: { kind: "http", url: "http://x" } } } }), "live");
});
