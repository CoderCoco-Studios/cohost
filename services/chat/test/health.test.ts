import { test } from "node:test";
import assert from "node:assert/strict";
import { runHeartbeat } from "@cohost/testing";
import { chatHealth } from "../src/health.js";

test("ready with a channel: live, twitch ok; shutdown sends one stopping", async () => {
  const hbs = await runHeartbeat(chatHealth("chan", () => true));
  assert.deepEqual(hbs.map((h) => h.state), ["starting", "ready", "stopping"]);
  assert.equal(hbs[1]!.service, "chat");
  assert.equal(hbs[1]!.mode, "live");
  assert.deepEqual(hbs[1]!.deps, { twitch: "ok" });
});

test("twitch disconnected reports down and degrades", async () => {
  const hbs = await runHeartbeat(chatHealth("chan", () => false));
  assert.deepEqual(hbs[1]!.deps, { twitch: "down" });
  assert.equal(hbs[1]!.state, "degraded");
});

test("no channel: mode off, twitch n/a, state degraded", async () => {
  const hbs = await runHeartbeat(chatHealth("", () => false), (hb) => hb.degraded("TWITCH_CHANNEL is not set"));
  const hb = hbs.find((h) => h.state === "degraded")!;
  assert.equal(hb.mode, "off");
  assert.deepEqual(hb.deps, { twitch: "n/a" });
});
