import { test } from "node:test";
import assert from "node:assert/strict";
import { event, recordingLog, testConfig } from "@cohost/testing";
import { EARS_LOOP_TYPES, EARS_JOIN_OPTIONS, createEarsHandler, isHumanSpeaker, subscribeEars, voiceTarget } from "../src/session.js";

// @spec EARS-SESS-007, CFG-USR-005
test("the guild and voice channel come from the ears.discord config keys, not the environment", () => {
  const prev = { g: process.env.DISCORD_GUILD_ID, c: process.env.DISCORD_VOICE_CHANNEL_ID };
  process.env.DISCORD_GUILD_ID = "env-guild";
  process.env.DISCORD_VOICE_CHANNEL_ID = "env-channel";
  try {
    const cfg = testConfig({ ears: { discord: { guild_id: "g-1", voice_channel_id: "vc-2" } } });
    assert.deepEqual(voiceTarget(cfg.ears.discord), { guildId: "g-1", channelId: "vc-2" });
    assert.throws(() => voiceTarget(testConfig({ ears: { discord: { voice_channel_id: "vc" } } }).ears.discord), /ears\.discord\.guild_id is not set/);
    assert.throws(() => voiceTarget(testConfig({ ears: { discord: { guild_id: "g" } } }).ears.discord), /ears\.discord\.voice_channel_id is not set/);
  } finally {
    if (prev.g === undefined) delete process.env.DISCORD_GUILD_ID; else process.env.DISCORD_GUILD_ID = prev.g;
    if (prev.c === undefined) delete process.env.DISCORD_VOICE_CHANNEL_ID; else process.env.DISCORD_VOICE_CHANNEL_ID = prev.c;
  }
});

const utterance = () => event("voice.utterance", { id: "u1", text: "hi", emotion: "neutral", durationMs: 100, envelopeHz: 50, envelope: [0], audioUrl: "http://voice/u1.wav", sampleRate: 24000 });
const inject = () => event("inject.request", { id: "i1", target: "ears", kind: "audio", url: "http://d/uploads/x", remember: false });

// @spec EARS-INJ-007
test("inject.request is handled by the one ears handler", async () => {
  const handled: string[] = [];
  const h = createEarsHandler({ onInject: async (ev) => { handled.push(ev.data.id); } });
  await h(inject());
  assert.deepEqual(handled, ["i1"]);
});

// @spec EARS-START-003
test("the ears loop reads inject.request only, and the handler ignores anything else it is handed", async () => {
  assert.deepEqual([...EARS_LOOP_TYPES], ["inject.request"]);
  const handled: string[] = [];
  const h = createEarsHandler({ onInject: async (ev) => { handled.push(ev.data.id); } });
  await h(utterance());
  await h(event("voice.playing", { id: "u1", sink: "discord" }));
  assert.deepEqual(handled, []);
});

// @spec EARS-HEAR-009
test("the ears loop never reads control", () => {
  assert.ok(!(EARS_LOOP_TYPES as readonly string[]).includes("control"));
});

// @spec EARS-SESS-002, EARS-SESS-004
test("ears joins self-muted and not self-deafened", () => {
  assert.deepEqual(EARS_JOIN_OPTIONS, { selfMute: true, selfDeaf: false });
});

// @spec EARS-HEAR-001
test("isHumanSpeaker: a human is captured; a bot account (cached or fetched) is not", async () => {
  const users = new Map([["human", { bot: false }], ["cachedbot", { bot: true }]]);
  const fetched: string[] = [];
  const lookup = {
    cache: { get: (id: string) => users.get(id) },
    fetch: async (id: string) => { fetched.push(id); return { bot: id === "fetchedbot" }; },
  };
  assert.equal(await isHumanSpeaker("human", lookup), true);
  assert.equal(await isHumanSpeaker("cachedbot", lookup), false);
  assert.deepEqual(fetched, [], "a cached user is not fetched");
  assert.equal(await isHumanSpeaker("fetchedbot", lookup), false);
  assert.equal(await isHumanSpeaker("newhuman", lookup), true);
  assert.deepEqual(fetched, ["fetchedbot", "newhuman"], "an uncached user is fetched before capture");
});

// @spec EARS-HEAR-001
test("isHumanSpeaker: a speaker whose account cannot be fetched is not captured", async () => {
  const lookup = { cache: { get: () => undefined }, fetch: async () => { throw new Error("unknown user"); } };
  assert.equal(await isHumanSpeaker("boom", lookup), false);
});

// @spec EARS-START-006
test("the ears group is created first, then subscribed with start mode latest for the given types", async () => {
  const calls: string[] = [];
  let opts: unknown;
  const bus = {
    resetGroup: async (g: string) => { calls.push(`reset:${g}`); },
    subscribe: async (o: unknown) => { calls.push("subscribe"); opts = o; },
  };
  await subscribeEars(bus, ["inject.request"], async () => {}, recordingLog().log);
  assert.deepEqual(calls, ["reset:ears", "subscribe"]);
  assert.deepEqual(opts, { group: "ears", types: ["inject.request"], start: "latest" });
});
