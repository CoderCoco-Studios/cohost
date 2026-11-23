import { test } from "node:test";
import assert from "node:assert/strict";
import { runHeartbeat } from "@cohost/testing";
import { chatHealth } from "../src/health.js";
import type { ChatSourceName, ChatSourceStatus } from "../src/source.js";

/** `chatHealth(listed sources, () => state of each listed source)`. */
const health = (sources: ChatSourceName[], states: Partial<Record<ChatSourceName, ChatSourceStatus["state"]>> = {}) =>
  chatHealth(sources, () => Object.fromEntries(sources.map((s) => [s, { state: states[s] ?? "starting" }])) as never);

// @spec CHAT-HEALTH-001, CHAT-HEALTH-003, CHAT-HEALTH-012
test("twitch reading: live, twitch ok, youtube n/a; shutdown sends one stopping", async () => {
  const hbs = await runHeartbeat(health(["twitch"], { twitch: "reading" }));
  assert.deepEqual(hbs.map((h) => h.state), ["starting", "ready", "stopping"]);
  assert.equal(hbs[1]!.service, "chat");
  assert.equal(hbs[1]!.mode, "live");
  assert.deepEqual(hbs[1]!.deps, { twitch: "ok", youtube: "n/a" });
});

// @spec CHAT-HEALTH-003, CHAT-HEALTH-004, CHAT-SRC-009
test("twitch is ok only while reading; waiting, retrying, stopped and starting are down and degrade a ready service", async () => {
  for (const state of ["starting", "waiting", "retrying", "stopped"] as const) {
    const hbs = await runHeartbeat(health(["twitch"], { twitch: state }));
    assert.deepEqual(hbs[1]!.deps, { twitch: "down", youtube: "n/a" }, state);
    assert.equal(hbs[1]!.state, "degraded", state);
  }
});

// @spec CHAT-HEALTH-009, CHAT-SRC-009, CHAT-HEALTH-012
test("youtube is ok only while reading, otherwise down; mode stays live", async () => {
  const ok = await runHeartbeat(health(["youtube"], { youtube: "reading" }));
  assert.deepEqual(ok[1]!.deps, { twitch: "n/a", youtube: "ok" });
  assert.equal(ok[1]!.mode, "live");
  for (const state of ["waiting", "retrying", "stopped"] as const) {
    const hbs = await runHeartbeat(health(["youtube"], { youtube: state }));
    assert.deepEqual(hbs[1]!.deps, { twitch: "n/a", youtube: "down" }, state);
  }
});

// @spec CHAT-HEALTH-011
test("a youtube source that is reading stays ok whatever the chat sends: health reads state only", async () => {
  const hbs = await runHeartbeat(health(["twitch", "youtube"], { twitch: "reading", youtube: "reading" }));
  assert.deepEqual(hbs[1]!.deps, { twitch: "ok", youtube: "ok" });
  assert.equal(hbs[1]!.state, "ready");
});

// @spec CHAT-HEALTH-002, CHAT-HEALTH-008, CHAT-HEALTH-010
test("fake alone: mode mock, ready, twitch and youtube n/a (the fake source has no dependency)", async () => {
  const hbs = await runHeartbeat(health(["fake"], { fake: "reading" }));
  assert.equal(hbs[1]!.mode, "mock");
  assert.deepEqual(hbs[1]!.deps, { twitch: "n/a", youtube: "n/a" });
  assert.equal(hbs[1]!.state, "ready");
});

// @spec CHAT-HEALTH-002
test("fake beside twitch is still mock, and twitch still reports from its own state", async () => {
  const hbs = await runHeartbeat(health(["twitch", "fake"], { twitch: "stopped", fake: "reading" }));
  assert.equal(hbs[1]!.mode, "mock");
  assert.deepEqual(hbs[1]!.deps, { twitch: "down", youtube: "n/a" });
});

// @spec CHAT-HEALTH-007, CHAT-PLAN-008
test("no sources: mode off, every dependency n/a, ready", async () => {
  const hbs = await runHeartbeat(health([]));
  assert.equal(hbs[1]!.mode, "off");
  assert.deepEqual(hbs[1]!.deps, { twitch: "n/a", youtube: "n/a" });
  assert.equal(hbs[1]!.state, "ready");
});

// @spec CHAT-HEALTH-005, CHAT-HEALTH-006
test("idle plan (every listed source a gap): live, the listed sources down, degraded with the reasons as detail", async () => {
  const hbs = await runHeartbeat(
    health(["twitch", "youtube"], { twitch: "stopped", youtube: "stopped" }),
    (hb) => hb.degraded("chat.twitch.channel is not set; chat.youtube.api_key is not set"),
  );
  const hb = hbs.find((h) => h.state === "degraded")!;
  assert.equal(hb.mode, "live");
  assert.deepEqual(hb.deps, { twitch: "down", youtube: "down" });
  assert.equal(hb.detail, "chat.twitch.channel is not set; chat.youtube.api_key is not set");
});

// @spec CHAT-HEALTH-008
test("the dependency of a source is read at each heartbeat, so a state change shows without rebuilding the spec", async () => {
  let state: ChatSourceStatus["state"] = "retrying";
  const spec = chatHealth(["twitch"], () => ({ twitch: { state } }) as never);
  assert.equal(spec.deps().twitch, "down");
  state = "reading";
  assert.equal(spec.deps().twitch, "ok");
});

// @spec CHAT-HEALTH-001
test("mode is a static string fixed at start", () => {
  const spec = health(["fake"]);
  assert.equal(typeof spec.mode, "string");
});
