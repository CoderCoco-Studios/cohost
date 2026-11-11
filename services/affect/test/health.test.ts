import { test } from "node:test";
import assert from "node:assert/strict";
import { runHeartbeat, testConfig } from "@cohost/testing";
import { affectHealth } from "../src/health.js";

test("ready with no external deps; shutdown sends one stopping", async () => { // @spec AFF-HEALTH-001
  const hbs = await runHeartbeat(affectHealth(testConfig()));
  assert.deepEqual(hbs.map((h) => h.state), ["starting", "ready", "stopping"]);
  assert.equal(hbs[1]!.service, "affect");
  assert.equal(hbs[1]!.mode, "live");
  assert.deepEqual(hbs[1]!.deps, {});
});

test("mode is mock only when the appraiser is an llm hook that inherits the mock provider", () => { // @spec AFF-HEALTH-003
  const mode = (over: Record<string, unknown>) => affectHealth(testConfig(over)).mode;
  assert.equal(mode({ llm: { provider: "mock" } }), "live", "rules appraiser: no model is called");
  assert.equal(mode({ llm: { provider: "mock" }, brain: { affect: { module: { kind: "llm" } } } }), "mock");
  assert.equal(mode({ llm: { provider: "ollama" }, brain: { affect: { module: { kind: "llm" } } } }), "live");
  assert.equal(
    mode({ llm: { provider: "mock" }, brain: { affect: { module: { kind: "llm", llm: { provider: "ollama", model: "small" } } } } }),
    "live",
    "the hook overrides the provider",
  );
  assert.equal(mode({ llm: { provider: "mock" }, brain: { affect: { module: { kind: "http", url: "http://x" } } } }), "live");
});
