import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { recordingLog, testConfig, waitFor } from "@cohost/testing";
import type { DiscordVoiceSessionOptions } from "@cohost/shared/discord-voice";
import { startDiscord } from "../src/discord.js";
import { EarsHealth } from "../src/health.js";

/** startDiscord with a fake shared voice session: nothing touches Discord. */
function rig(startImpl: () => Promise<void> = async () => {}) {
  const order: string[] = [];
  const rec = recordingLog();
  let opts!: DiscordVoiceSessionOptions;
  let voiceReady = false;
  const beats: string[] = [];
  const heartbeat = { ready: () => beats.push("ready"), degraded: (d?: string) => beats.push(`degraded:${d}`) };
  const bus = {
    resetGroup: async () => { order.push("resetGroup"); },
    subscribe: () => { order.push("subscribe"); return new Promise<void>(() => {}); },
  };
  const health = new EarsHealth("discord", () => voiceReady);
  const createSession = (o: DiscordVoiceSessionOptions) => {
    opts = o;
    return { start: async () => { order.push("session.start"); await startImpl(); }, isReady: () => voiceReady, stop: async () => { order.push("session.stop"); } };
  };
  const deps = {
    cfg: testConfig({ ears: { discord: { guild_id: "g", voice_channel_id: "vc" }, silence_ms: 700 } }),
    bus: bus as never, log: rec.log, health, heartbeat: heartbeat as never, token: "ears-tok",
    setVoiceReady: (v: boolean) => { voiceReady = v; },
    onInject: () => {},
    createSession: createSession as never,
  };
  return { deps, order, rec, beats, health, get opts() { return opts; }, ready: () => voiceReady };
}

// @spec EARS-SESS-010, EARS-SESS-002, EARS-SESS-009
test("the voice session is shared, self-muted, listening, with join retry 5 s doubling to 60 s", async () => {
  const r = rig();
  const s = await startDiscord(r.deps);
  assert.equal(r.opts.token, "ears-tok");
  assert.equal(r.opts.selfMute, true);
  assert.equal(r.opts.selfDeaf, false);
  assert.deepEqual(r.opts.join, { baseMs: 5000, maxMs: 60000 });
  const target = [typeof r.opts.guildId === "function" ? r.opts.guildId() : r.opts.guildId, typeof r.opts.channelId === "function" ? r.opts.channelId() : r.opts.channelId];
  assert.deepEqual(target, ["g", "vc"]);
  await s.stop();
  assert.ok(r.order.includes("session.stop"));
});

// @spec EARS-SESS-010, EARS-INJ-007
test("the bus subscription starts before the session, and a failed join keeps it running as degraded / discord down", async () => {
  const r = rig();
  await startDiscord(r.deps);
  assert.deepEqual(r.order.slice(0, 3), ["resetGroup", "subscribe", "session.start"]);
  r.opts.onJoinFailed!(new Error("not a voice channel"), 1);
  assert.deepEqual(r.beats, ["degraded:voice join failed: Error: not a voice channel"]);
  assert.equal(r.ready(), false);
  assert.equal((r.health.spec.deps as () => Record<string, string>)().discord, "down");
});

// @spec EARS-SESS-010, EARS-SESS-004
test("a connected session reports ready and discord ok; a disconnect sets discord down", async () => {
  const r = rig();
  await startDiscord(r.deps);
  const receiver = { speaking: new EventEmitter(), subscribe: () => new PassThrough() };
  r.opts.onConnected({ receiver } as never, { client: { users: { cache: new Map(), fetch: async () => ({ bot: false }) } }, channel: { guild: { members: { cache: new Map() } } } } as never);
  assert.deepEqual(r.beats, ["ready"]);
  assert.equal((r.health.spec.deps as () => Record<string, string>)().discord, "ok");
  r.opts.onDisconnected!();
  assert.equal((r.health.spec.deps as () => Record<string, string>)().discord, "down");
});

// @spec EARS-SESS-001
test("a login failure rejects start-up (the service entry ends the process with status 1)", async () => {
  const r = rig(async () => { throw new Error("TOKEN_INVALID"); });
  await assert.rejects(startDiscord(r.deps), /TOKEN_INVALID/);
  assert.ok(r.rec.msgs("error").includes("discord login failed"));
});

// @spec EARS-HEAR-001, EARS-HEAR-002
test("capture: a human speaker is subscribed once per utterance with the silence window; a bot account is never captured", async () => {
  const r = rig();
  await startDiscord(r.deps);
  const subscribed: { id: string; duration: number }[] = [];
  const streams: PassThrough[] = [];
  const receiver = {
    speaking: new EventEmitter(),
    subscribe: (id: string, o: { end: { duration: number } }) => { subscribed.push({ id, duration: o.end.duration }); const p = new PassThrough(); streams.push(p); return p; },
  };
  const users = new Map([["human", { bot: false }], ["bot", { bot: true }]]);
  r.opts.onConnected({ receiver } as never, {
    client: { users: { cache: { get: (id: string) => users.get(id) }, fetch: async () => { throw new Error("unknown"); } } },
    channel: { guild: { members: { cache: new Map([["human", { displayName: "Chris" }]]) } } },
  } as never);
  receiver.speaking.emit("start", "bot");
  receiver.speaking.emit("start", "stranger");
  receiver.speaking.emit("start", "human");
  receiver.speaking.emit("start", "human");
  await waitFor(() => subscribed.length >= 1, "a subscription");
  await new Promise((x) => setTimeout(x, 20));
  assert.deepEqual(subscribed, [{ id: "human", duration: 700 }], "one subscription, human only");
  // The utterance ends; the speaker can then be captured again.
  streams[0]!.end();
  await new Promise((x) => setTimeout(x, 20));
  receiver.speaking.emit("start", "human");
  await waitFor(() => subscribed.length === 2, "a second capture after the first ended");
  streams[1]!.end();
});
