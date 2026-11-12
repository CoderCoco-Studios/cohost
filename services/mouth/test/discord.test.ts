import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { GatewayIntentBits } from "discord.js";
import { AudioPlayerStatus, VoiceConnectionStatus } from "@discordjs/voice";
import { FakeBus, recordingLog, testConfig, waitFor } from "@cohost/testing";
import { wavWrap } from "@cohost/shared";
import { createDiscordOutput } from "../src/discord.js";

class FakeConnection extends EventEmitter {
  destroyed = false;
  subscribed: unknown[] = [];
  destroy() { this.destroyed = true; }
  subscribe(player: unknown) { this.subscribed.push(player); }
}
class FakePlayer extends EventEmitter {
  played: unknown[] = [];
  stops = 0;
  play(resource: unknown) { this.played.push(resource); }
  stop() { this.stops++; }
}

/** The Discord output with discord.js, @discordjs/voice's join and the player all faked. */
function rig(over: { loginError?: Error; failJoins?: number; guildId?: string; channelId?: string; gainDb?: number; graceMs?: number } = {}) {
  const cfg = testConfig({ mouth: { outputs: { discord: { guild_id: over.guildId ?? "g1", voice_channel_id: over.channelId ?? "chan", gain_db: over.gainDb ?? 0 } } } });
  const channel = { id: "chan", name: "General", isVoiceBased: () => true };
  const guild = { id: "g1", channels: { fetch: async () => channel }, voiceAdapterCreator: {} };
  const client = Object.assign(new EventEmitter(), {
    logins: [] as string[], destroyed: 0, user: { tag: "bot#1" },
    guilds: { fetch: async () => guild },
    login: async (t: string) => { client.logins.push(t); if (over.loginError) throw over.loginError; },
    destroy: async () => { client.destroyed++; },
  });
  const intents: unknown[] = [];
  const joins: Record<string, unknown>[] = [];
  const conns: FakeConnection[] = [];
  const sleeps: number[] = [];
  let joinsToFail = over.failJoins ?? 0;
  let recover = false;
  const player = new FakePlayer();
  const bus = new FakeBus();
  const rec = recordingLog();
  const state = { ready: false };
  const hb: string[] = [];
  const resources: Buffer[] = [];
  const { output, session } = createDiscordOutput({
    cfg, bus, log: rec.log as never, token: "tok",
    heartbeat: { ready: () => hb.push("ready"), degraded: (d) => hb.push(`degraded:${d}`) } as never,
    fallback: undefined,
    setReady: (v) => { state.ready = v; }, isReady: () => state.ready,
    fetchAudio: async () => wavWrap(Buffer.alloc(24 * 20 * 2), 24000, 1),
    createPlayer: () => player as never,
    guard: { watchdogGraceMs: over.graceMs ?? 10_000 },
    createResource: (pcm) => { resources.push(pcm); return { pcm } as never; },
    voice: {
      createClient: (i) => { intents.push(...i); return client as never; },
      joinVoiceChannel: ((o: Record<string, unknown>) => { joins.push(o); const c = new FakeConnection(); conns.push(c); return c; }) as never,
      entersState: (async (_c: unknown, status: string) => {
        if (status === VoiceConnectionStatus.Ready && joinsToFail > 0) { joinsToFail--; throw new Error("not ready"); }
        if (status !== VoiceConnectionStatus.Ready && !recover) throw new Error("did not recover");
      }) as never,
      sleep: async (ms) => { sleeps.push(ms); await new Promise((r) => setImmediate(r)); },
    },
  });
  return { output, session, client, intents, joins, conns, sleeps, player, bus, rec, state, hb, resources, recover: () => { recover = true; } };
}

// @spec MOUTH-SESS-002, MOUTH-SESS-004, MOUTH-SESS-008, MOUTH-SESS-009
test("discord: logs in with DISCORD_TOKEN's value, joins self-deafened and not self-muted, attaches the player and reports ready", async () => {
  const r = rig();
  try {
    await r.session.start();
    assert.deepEqual(r.client.logins, ["tok"]);
    assert.deepEqual(r.intents, [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates], "no privileged GuildMembers intent");
    assert.equal(r.output.name, "discord");
    assert.equal(r.output.isReady(), false, "not ready before the join");
    r.client.emit("ready");
    await waitFor(() => r.state.ready, "the output ready");
    assert.equal(r.joins[0]!.guildId, "g1");
    assert.equal(r.joins[0]!.channelId, "chan");
    assert.equal(r.joins[0]!.selfDeaf, true);
    assert.equal(r.joins[0]!.selfMute, false);
    assert.deepEqual(r.conns[0]!.subscribed, [r.player]);
    assert.equal(r.output.isReady(), true);
    assert.deepEqual(r.hb, ["ready"]);
  } finally {
    await r.session.stop();
  }
  assert.equal(r.client.destroyed, 1);
  assert.equal(r.conns[0]!.destroyed, true);
});

// @spec MOUTH-SESS-003, MOUTH-SESS-009
test("discord: an unset guild fails the join with the key's name, is reported degraded with the failure, and keeps retrying 5 s then 10 s", async () => {
  const r = rig({ guildId: "" });
  try {
    await r.session.start();
    r.client.emit("ready");
    await waitFor(() => r.sleeps.length >= 2, "two retries");
    assert.deepEqual(r.sleeps.slice(0, 2), [5000, 10000]);
    assert.ok(r.hb.length >= 2 && r.hb.every((h) => h.startsWith("degraded:voice join failed: ")));
    assert.match(r.hb[0]!, /mouth\.outputs\.discord\.guild_id is not set/);
    assert.equal(r.state.ready, false);
    assert.equal(r.output.isReady(), false);
  } finally {
    await r.session.stop();
  }
});

// @spec MOUTH-SESS-009
test("discord: a join that does not reach Ready is retried and recovers, then the heartbeat is ready", async () => {
  const r = rig({ failJoins: 1 });
  try {
    await r.session.start();
    r.client.emit("ready");
    await waitFor(() => r.state.ready, "ready after one failed join");
    assert.deepEqual(r.hb, ["degraded:voice join failed: Error: not ready", "ready"]);
    assert.equal(r.conns[0]!.destroyed, true, "the half-open connection was destroyed");
  } finally {
    await r.session.stop();
  }
});

// @spec MOUTH-SESS-009
test("discord: a disconnect that does not recover marks the output not ready and it rejoins", async () => {
  const r = rig();
  try {
    await r.session.start();
    r.client.emit("ready");
    await waitFor(() => r.state.ready, "ready");
    r.conns[0]!.emit(VoiceConnectionStatus.Disconnected);
    await waitFor(() => !r.state.ready || r.conns.length > 1, "marked not ready");
    await waitFor(() => r.conns.length === 2 && r.state.ready, "rejoined");
    assert.equal(r.conns[0]!.destroyed, true);
    assert.ok(r.sleeps.includes(5000), "rejoin after 5 s");
  } finally {
    await r.session.stop();
  }
});

// @spec MOUTH-SESS-001
test("discord: a login failure rejects start()", async () => {
  const r = rig({ loginError: new Error("An invalid token was provided") });
  await assert.rejects(() => r.session.start(), /invalid token/);
  await r.session.stop();
});

// @spec MOUTH-PLAY-002, MOUTH-PLAY-003, MOUTH-PLAY-004, MOUTH-ROUTE-005
test("discord: a queued line becomes a raw PCM resource on the player, and the player's Idle ends it with voice.done under sink discord", async () => {
  const r = rig({ gainDb: 6 });
  try {
    await r.output.playback.enqueue("u1", "http://voice/u1.wav");
    assert.equal(r.player.played.length, 1);
    assert.equal(r.resources[0]!.length, 960 * 4, "20 ms of 24 kHz mono at 48 kHz stereo s16le");
    assert.deepEqual(r.bus.published, [{ type: "voice.playing", data: { id: "u1", sink: "discord" } }]);
    r.player.emit(AudioPlayerStatus.Idle);
    await waitFor(() => r.bus.of("voice.done").length === 1, "voice.done");
    assert.deepEqual(r.bus.of("voice.done"), [{ id: "u1", sink: "discord" }]);
  } finally {
    r.output.close();
  }
});

// @spec MOUTH-PLAY-007
test("discord: a player error is logged as player error naming the output and ends nothing", async () => {
  const r = rig();
  try {
    await r.output.playback.enqueue("u1", "http://voice/u1.wav");
    r.player.emit("error", new Error("decoder blew up"));
    assert.deepEqual(r.rec.msgs("warn"), ["player error"]);
    assert.equal((r.rec.lines[0]!.obj as { output: string }).output, "discord");
    assert.equal(r.bus.of("voice.done").length, 0);
  } finally {
    r.output.close();
  }
});

// @spec MOUTH-PLAY-011
test("discord: the watchdog's player stop reaches the audio player", async () => {
  const r = rig({ graceMs: 20 });
  try {
    await r.output.playback.enqueue("u1", "http://voice/u1.wav");
    await waitFor(() => r.player.stops === 1, "the player stopped");
    await waitFor(() => r.bus.of("voice.failed").length === 1, "the line given up");
  } finally {
    r.output.close();
  }
});
