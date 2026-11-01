import { test } from "node:test";
import assert from "node:assert/strict";
import { runHeartbeat } from "@cohost/testing";
import { chatHealth } from "../src/health.js";

// @spec CHAT-HEALTH-001, CHAT-HEALTH-003
test("ready with a channel: live, twitch ok; shutdown sends one stopping", async () => {
  const hbs = await runHeartbeat(chatHealth("chan", () => true));
  assert.deepEqual(hbs.map((h) => h.state), ["starting", "ready", "stopping"]);
  assert.equal(hbs[1]!.service, "chat");
  assert.equal(hbs[1]!.mode, "live");
  assert.deepEqual(hbs[1]!.deps, { twitch: "ok" });
});

// @spec CHAT-HEALTH-003, CHAT-HEALTH-004
test("twitch disconnected reports down and degrades", async () => {
  const hbs = await runHeartbeat(chatHealth("chan", () => false));
  assert.deepEqual(hbs[1]!.deps, { twitch: "down" });
  assert.equal(hbs[1]!.state, "degraded");
});

// @spec CHAT-HEALTH-005, CHAT-HEALTH-006
test("no channel (twitch source): stays live-mode, twitch down, state degraded", async () => {
  const hbs = await runHeartbeat(chatHealth("", () => false), (hb) => hb.degraded("TWITCH_CHANNEL is not set"));
  const hb = hbs.find((h) => h.state === "degraded")!;
  assert.equal(hb.mode, "live");
  assert.deepEqual(hb.deps, { twitch: "down" });
});

// @spec CHAT-HEALTH-002
test("fake source: mode mock, twitch n/a, ready", async () => {
  const hbs = await runHeartbeat(chatHealth("", () => false, "fake"));
  assert.equal(hbs[1]!.mode, "mock");
  assert.deepEqual(hbs[1]!.deps, { twitch: "n/a" });
  assert.equal(hbs[1]!.state, "ready");
});
