import { test } from "node:test";
import assert from "node:assert/strict";
import { event, recordingLog, testConfig } from "@cohost/testing";
import { MOUTH_LOOP_TYPES, createMouthHandler, outputTarget, subscribeMouth } from "../src/session.js";
import { ClaimMemory } from "../src/fallback.js";

const discordCfg = (over: Record<string, unknown> = {}) => testConfig({ mouth: { outputs: { discord: over } } }).mouth.outputs.discord;

// @spec MOUTH-SESS-002, MOUTH-SESS-003
test("the guild and voice channel come from the mouth.outputs.discord config keys, not the environment", () => {
  const prev = { g: process.env.DISCORD_GUILD_ID, c: process.env.DISCORD_VOICE_CHANNEL_ID };
  process.env.DISCORD_GUILD_ID = "env-guild";
  process.env.DISCORD_VOICE_CHANNEL_ID = "env-channel";
  try {
    assert.deepEqual(outputTarget(discordCfg({ guild_id: "g-1", voice_channel_id: "vc-2" })), { guildId: "g-1", channelId: "vc-2" });
  } finally {
    if (prev.g === undefined) delete process.env.DISCORD_GUILD_ID; else process.env.DISCORD_GUILD_ID = prev.g;
    if (prev.c === undefined) delete process.env.DISCORD_VOICE_CHANNEL_ID; else process.env.DISCORD_VOICE_CHANNEL_ID = prev.c;
  }
});

// @spec MOUTH-SESS-003
test("an empty guild or channel fails the join with a message naming the key", () => {
  assert.throws(() => outputTarget(discordCfg({ voice_channel_id: "vc" })), /^Error: mouth\.outputs\.discord\.guild_id is not set$/);
  assert.throws(() => outputTarget(discordCfg({ guild_id: "g" })), /^Error: mouth\.outputs\.discord\.voice_channel_id is not set$/);
  assert.throws(() => outputTarget(testConfig().mouth.outputs.discord), /guild_id is not set/, "an old config.yaml with no mouth section: empty defaults");
});

const utterance = (id = "u1") => event("voice.utterance", { id, text: "hi", emotion: "neutral", durationMs: 100, envelopeHz: 50, envelope: [0], audioUrl: `http://voice/${id}.wav`, sampleRate: 24000 });
const playingEv = (id: string, sink: string) => event("voice.playing", { id, sink });
const failedEv = () => event("voice.failed", { id: "u1", sink: "discord", reason: "x" });
const out = (name: string, ready: () => boolean, queued: [string, string, string][]) => ({
  name, isReady: ready, playback: { enqueue: async (id: string, url: string) => { queued.push([name, id, url]); } },
});

// @spec MOUTH-ROUTE-003, MOUTH-FALL-013
test("a voice.utterance is queued on every ready output and skipped, unqueued, on an output that is not ready", async () => {
  const queued: [string, string, string][] = [];
  let bReady = false;
  const h = createMouthHandler({ outputs: [out("discord", () => true, queued), out("second", () => bReady, queued)], claims: new ClaimMemory(), log: recordingLog().log });
  await h(utterance());
  assert.deepEqual(queued, [["discord", "u1", "http://voice/u1.wav"]]);
  bReady = true;
  await h(utterance("u2"));
  assert.deepEqual(queued.slice(1), [["discord", "u2", "http://voice/u2.wav"], ["second", "u2", "http://voice/u2.wav"]]);
});

// @spec MOUTH-ROUTE-003, MOUTH-ROUTE-002
test("with no ready output nothing is queued and the handler publishes nothing itself", async () => {
  const queued: [string, string, string][] = [];
  const h = createMouthHandler({ outputs: [out("discord", () => false, queued)], claims: new ClaimMemory(), log: recordingLog().log });
  await h(utterance());
  assert.deepEqual(queued, []);
});

// @spec MOUTH-FALL-010
test("the loop remembers each utterance id and every voice.playing claim, and ignores voice.failed", async () => {
  const seen: string[] = [];
  const claims: [string, string][] = [];
  const h = createMouthHandler({
    outputs: [out("discord", () => true, [])], log: recordingLog().log,
    claims: { seen: (id) => { seen.push(id); }, claim: (id, sink) => { claims.push([id, sink]); } },
  });
  await h(utterance());
  await h(playingEv("u1", "dashboard"));
  await h(playingEv("u1", "discord"));
  await h(playingEv("u1", "virtual"));
  await h(failedEv());
  assert.deepEqual(seen, ["u1"]);
  assert.deepEqual(claims, [["u1", "dashboard"], ["u1", "discord"], ["u1", "virtual"]], "every claim is forwarded; the fallback line filters virtual and its own");
});

// @spec MOUTH-PLAY-001, MOUTH-PLAY-008
test("the one mouth loop reads voice.utterance, voice.playing and control (set_routing only)", () => {
  assert.deepEqual([...MOUTH_LOOP_TYPES].sort(), ["control", "voice.playing", "voice.utterance"]);
});

// @spec MOUTH-START-005, MOUTH-PLAY-001
test("the mouth group is created first, then subscribed with start mode latest, before any login", async () => {
  const calls: string[] = [];
  let opts: unknown;
  const bus = {
    resetGroup: async (g: string) => { calls.push(`reset:${g}`); },
    subscribe: async (o: unknown) => { calls.push("subscribe"); opts = o; },
  };
  await subscribeMouth(bus, async () => {}, recordingLog().log);
  assert.deepEqual(calls, ["reset:mouth", "subscribe"]);
  assert.deepEqual(opts, { group: "mouth", types: ["voice.utterance", "voice.playing", "control"], start: "latest" });
});
