import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { ConfigSchema } from "../src/index.js";
import { repo } from "./helpers/config-sandbox.js";

const baseCfg = () => ({
  cohost: { name: "a", streamer: "b" }, llm: { model: "m", embed_model: "e" }, vision: { model: "v", obs: {} },
  voice: {}, avatar: { vtube_studio: { host: "h" }, vmc: { host: "h" } }, ears: {}, dashboard: {}, brain: {},
});
const parse = (chat: Record<string, unknown>) => ConfigSchema.safeParse({ ...baseCfg(), chat });
const ok = (chat: Record<string, unknown>): any => { const r = parse(chat); assert.ok(r.success, JSON.stringify(r.error?.issues)); return r.data.chat; };
const failsAt = (chat: Record<string, unknown>, path: string) => {
  const r = parse(chat);
  return !r.success && r.error.issues.some((i) => i.path.join(".") === path || i.path.join(".").startsWith(`${path}.`));
};

// @spec CFG-SCH-048
test("chat.sources defaults to [twitch] when absent or null, may be empty, and reads a repeated name once", () => {
  assert.deepEqual(ok({}).sources, ["twitch"]);
  assert.deepEqual(ok({ sources: null }).sources, ["twitch"]);
  assert.deepEqual(ok({ sources: [] }).sources, []);
  assert.deepEqual(ok({ sources: ["twitch", "youtube", "fake"] }).sources, ["twitch", "youtube", "fake"]);
  assert.deepEqual(ok({ sources: ["youtube", "twitch", "youtube"] }).sources, ["youtube", "twitch"]);
});

// @spec CFG-SCH-048, CFG-ISO-003
test("a chat.sources name outside twitch, youtube and fake fails the load naming chat.sources", () => {
  assert.ok(failsAt({ sources: ["irc"] }, "chat.sources"));
  assert.ok(failsAt({ sources: ["twitch", "Twitch"] }, "chat.sources"));
  assert.ok(failsAt({ sources: [""] }, "chat.sources"));
});

// @spec CFG-SCH-048
test("the single chat.source key is gone from the schema", () => {
  assert.equal("source" in ok({}), false);
});

// @spec CFG-SCH-049
test("chat.youtube is optional and its keys default: video and api_key empty, transport stream, poll_floor_ms 12000, recheck_ms 120000", () => {
  const defaults = { video: "", api_key: "", transport: "stream", poll_floor_ms: 12000, recheck_ms: 120000 };
  assert.deepEqual(ok({}).youtube, defaults);
  assert.deepEqual(ok({ youtube: {} }).youtube, defaults);
  const set = ok({ youtube: { video: "abc", transport: "poll", poll_floor_ms: 1000, recheck_ms: 30000 } }).youtube;
  assert.deepEqual([set.video, set.transport, set.poll_floor_ms, set.recheck_ms], ["abc", "poll", 1000, 30000]);
});

// @spec CFG-SCH-050, CFG-ISO-003
test("chat.youtube.transport blank is stream; a value other than stream and poll fails naming chat.youtube.transport", () => {
  assert.equal(ok({ youtube: { transport: "" } }).youtube.transport, "stream");
  assert.equal(ok({ youtube: { transport: "poll" } }).youtube.transport, "poll");
  assert.ok(failsAt({ youtube: { transport: "websocket" } }, "chat.youtube.transport"));
});

// @spec CFG-SCH-051
test("chat.youtube.poll_floor_ms must be an integer of at least 1000", () => {
  for (const bad of [999, 0, -1, 1000.5, "fast", null]) assert.ok(failsAt({ youtube: { poll_floor_ms: bad } }, "chat.youtube.poll_floor_ms"), String(bad));
  assert.equal(ok({ youtube: { poll_floor_ms: 1000 } }).youtube.poll_floor_ms, 1000);
});

// @spec CFG-SCH-052
test("chat.youtube.recheck_ms must be an integer of at least 30000", () => {
  for (const bad of [29999, 0, -1, 30000.5, "slow", null]) assert.ok(failsAt({ youtube: { recheck_ms: bad } }, "chat.youtube.recheck_ms"), String(bad));
  assert.equal(ok({ youtube: { recheck_ms: 30000 } }).youtube.recheck_ms, 30000);
});

// @spec CFG-SCH-053
test("chat.youtube.video accepts any string, including one that names no video", () => {
  for (const v of ["", "dQw4w9WgXcQ", "https://youtu.be/x", "@somehandle", "not a video at all !!", "UC".padEnd(300, "x")]) assert.equal(ok({ youtube: { video: v } }).youtube.video, v);
});

// @spec CFG-SCH-054, CFG-SCH-010
test("an absent chat.twitch is an object of defaults, as is an absent chat.youtube; vision.obs stays required", () => {
  const c = ok({});
  assert.deepEqual(c.twitch, { channel: "", client_id: "", client_secret: "", access_token: "", refresh_token: "" });
  assert.equal(typeof c.youtube, "object");
  assert.deepEqual(ok({ twitch: {} }).twitch, c.twitch);
  assert.equal(ConfigSchema.safeParse({ ...baseCfg(), chat: {}, vision: { model: "v" } }).success, false, "vision.obs is still required");
});

// @spec CFG-USR-018
test("config.example.yaml writes chat.sources [twitch] and the chat.youtube defaults as literals and no chat.source key", () => {
  const text = readFileSync(join(repo, "config", "config.example.yaml"), "utf8");
  const chat = (parseYaml(text) as any).chat;
  assert.deepEqual(chat.sources, ["twitch"]);
  assert.equal("source" in chat, false);
  assert.equal(chat.youtube.video, "");
  assert.equal(chat.youtube.transport, "stream");
  assert.equal(chat.youtube.poll_floor_ms, 12000);
  assert.equal(chat.youtube.recheck_ms, 120000);
  const block = text.slice(text.indexOf("\nchat:"), text.indexOf("\nbrain:"));
  assert.doesNotMatch(block, /\$\{/);
  assert.doesNotMatch(block, /^\s+source:/m);
});
