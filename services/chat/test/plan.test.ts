import { test } from "node:test";
import assert from "node:assert/strict";
import { testConfig } from "@cohost/testing";
import { sourcePlan } from "../src/plan.js";

/** Plan for a config override of `chat`; the test config's default channel is `chan`. */
const plan = (chat: Record<string, unknown>) => sourcePlan(testConfig({ chat }).chat);
const yt = (youtube: Record<string, unknown>) => plan({ sources: ["youtube"], youtube });
const reasons = (e: { status: string; reasons?: string[] } | undefined) => e?.reasons;

// @spec CHAT-PLAN-007
test("an absent or null chat.sources plans [twitch]", () => {
  assert.deepEqual(sourcePlan({ sources: undefined, twitch: { channel: "chan" }, youtube: {} } as never).map((e) => e.source), ["twitch"]);
  assert.deepEqual(sourcePlan({ sources: null, twitch: { channel: "chan" }, youtube: {} } as never).map((e) => e.source), ["twitch"]);
  assert.deepEqual(plan({}).map((e) => e.source), ["twitch"]);
});

// @spec CHAT-PLAN-008
test("an empty chat.sources plans nothing", () => {
  assert.deepEqual(plan({ sources: [] }), []);
});

// @spec CHAT-PLAN-009
test("a source listed twice is planned once, in first-occurrence order", () => {
  assert.deepEqual(
    sourcePlan({ sources: ["fake", "twitch", "fake", "twitch"], twitch: { channel: "chan" }, youtube: {} } as never).map((e) => e.source),
    ["fake", "twitch"],
  );
});

// @spec CHAT-PLAN-001, CHAT-PLAN-002
test("fake is always runnable; twitch is runnable with a channel after normalisation and a gap without", () => {
  assert.equal(plan({ sources: ["fake"], twitch: { channel: "" } })[0]!.status, "runnable");
  assert.equal(plan({ sources: ["twitch"], twitch: { channel: "#Chan" } })[0]!.status, "runnable");
  const blank = plan({ sources: ["twitch"], twitch: { channel: "" } })[0]!;
  assert.equal(blank.status, "gap");
  assert.deepEqual(reasons(blank), ["chat.twitch.channel is not set"]);
  assert.equal(plan({ sources: ["twitch"], twitch: { channel: "#" } })[0]!.status, "gap", "a lone # is empty after normalisation");
});

// @spec CHAT-PLAN-012
test("youtube with an empty api key is a gap naming chat.youtube.api_key", () => {
  assert.deepEqual(reasons(yt({ api_key: "", video: "dQw4w9WgXcQ" })[0]), ["chat.youtube.api_key is not set"]);
});

// @spec CHAT-PLAN-012, CHAT-YT-003
test("a whitespace-only api key is unset", () => {
  assert.deepEqual(reasons(yt({ api_key: "  \t ", video: "dQw4w9WgXcQ" })[0]), ["chat.youtube.api_key is not set"]);
});

// @spec CHAT-PLAN-013
test("youtube with an empty video is a gap naming chat.youtube.video", () => {
  assert.deepEqual(reasons(yt({ api_key: "k", video: "" })[0]), ["chat.youtube.video is not set"]);
});

// @spec CHAT-PLAN-014, CHAT-YT-006
test("youtube with a video that names no video is a gap and the config load does not fail", () => {
  assert.deepEqual(
    reasons(yt({ api_key: "k", video: "https://www.youtube.com/@handle" })[0]),
    ["chat.youtube.video is not a YouTube video URL or id"],
  );
});

// @spec CHAT-PLAN-012, CHAT-PLAN-013, CHAT-PLAN-014
test("every applicable youtube reason is given: api key first, then the video reason", () => {
  assert.deepEqual(reasons(yt({ api_key: "", video: "" })[0]), ["chat.youtube.api_key is not set", "chat.youtube.video is not set"]);
  assert.deepEqual(reasons(yt({ api_key: "", video: "a phrase" })[0]), ["chat.youtube.api_key is not set", "chat.youtube.video is not a YouTube video URL or id"]);
});

// @spec CHAT-PLAN-002, CHAT-YT-004, CHAT-YT-005
test("youtube with a key and a video of any accepted form is runnable", () => {
  assert.equal(yt({ api_key: "k", video: "dQw4w9WgXcQ" })[0]!.status, "runnable");
  assert.equal(yt({ api_key: "k", video: "youtu.be/dQw4w9WgXcQ" })[0]!.status, "runnable");
});

// @spec CHAT-PLAN-003, CHAT-PLAN-010
test("entries keep the order chat.sources lists; each source carries its own status", () => {
  const p = plan({ sources: ["youtube", "fake", "twitch"], twitch: { channel: "" }, youtube: { api_key: "", video: "" } });
  assert.deepEqual(p.map((e) => [e.source, e.status]), [["youtube", "gap"], ["fake", "runnable"], ["twitch", "gap"]]);
});

// @spec CHAT-PLAN-010
test("sourcePlan is pure: equal plans for the same config, and the config is not mutated", () => {
  const cfg = testConfig({ chat: { sources: ["twitch", "youtube"], youtube: { api_key: " ", video: "" } } }).chat;
  const before = JSON.stringify(cfg);
  assert.deepEqual(sourcePlan(cfg), sourcePlan(cfg));
  assert.equal(JSON.stringify(cfg), before);
});
