import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { VoiceConnectionStatus } from "@discordjs/voice";
import { createDiscordVoiceSession } from "../src/discord-voice.js";

class FakeConnection extends EventEmitter {
  destroyed = false;
  destroy() { this.destroyed = true; }
}

function rig(over: { enters?: (c: FakeConnection, status: string, ms: number) => Promise<void>; loginError?: Error; failJoins?: number; notVoice?: boolean } = {}) {
  const client = Object.assign(new EventEmitter(), {
    destroyed: 0,
    logins: [] as string[],
    guilds: { fetch: async () => guild },
    login: async (t: string) => { client.logins.push(t); if (over.loginError) throw over.loginError; },
    destroy: async () => { client.destroyed++; },
    user: { tag: "bot#1" },
  });
  const channel = { id: "chan", name: "General", isVoiceBased: () => !over.notVoice };
  const members = { fetched: 0, fetch: async () => { members.fetched++; } };
  const guild = { id: "g1", channels: { fetch: async () => channel }, members, voiceAdapterCreator: {} };
  const conns: FakeConnection[] = [];
  const joinOpts: Record<string, unknown>[] = [];
  const sleeps: number[] = [];
  const enters: [string, number][] = [];
  const events: string[] = [];
  let joinsToFail = over.failJoins ?? 0;
  const session = createDiscordVoiceSession({
    token: "tok", guildId: "g1", channelId: "chan", intents: [1, 2], selfMute: true, selfDeaf: false,
    log: { info() {}, warn() {}, error() {} } as never,
    fetchMembers: true,
    onConnected: (c) => { events.push("connected"); void c; },
    onDisconnected: () => { events.push("disconnected"); },
    onJoinFailed: (_e, n) => { events.push(`failed:${n}`); },
    join: { baseMs: 5000, maxMs: 60_000 },
    deps: {
      createClient: () => client as never,
      joinVoiceChannel: ((o: Record<string, unknown>) => { joinOpts.push(o); const c = new FakeConnection(); conns.push(c); return c; }) as never,
      entersState: (async (c: FakeConnection, status: string, ms: number) => {
        enters.push([status, ms]);
        if (status === VoiceConnectionStatus.Ready && joinsToFail > 0) { joinsToFail--; throw new Error("not ready"); }
        if (over.enters) return over.enters(c, status, ms);
      }) as never,
      sleep: async (ms: number) => { sleeps.push(ms); await new Promise((r) => setImmediate(r)); },
    },
  });
  return { session, client, conns, joinOpts, sleeps, enters, events, members };
}
const tick = () => new Promise((r) => setTimeout(r, 5));
const until = async (cond: () => boolean, ms = 3000) => {
  const t0 = performance.now();
  while (!cond()) { if (performance.now() - t0 > ms) throw new Error("condition not reached"); await new Promise((r) => setTimeout(r, 2)); }
};

// @spec SHARED-DVS-001
test("no module reachable from the main entry imports discord.js or @discordjs/voice", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const dir = new URL("../src/", import.meta.url);
  const reach = new Set<string>();
  const walk = (file: string) => {
    if (reach.has(file)) return;
    reach.add(file);
    const text = readFileSync(new URL(file, dir), "utf8");
    for (const m of text.matchAll(/from "\.\/([\w-]+)\.js"/g)) walk(`${m[1]}.ts`);
  };
  walk("index.ts");
  assert.ok(reach.has("boot.ts") && !reach.has("discord-voice.ts"));
  for (const f of reach) assert.doesNotMatch(readFileSync(new URL(f, dir), "utf8"), /from "(discord\.js|@discordjs\/voice)"/, f);
  assert.ok(readdirSync(dir).includes("discord-voice.ts"));
});

// @spec SHARED-DVS-002
test("start() logs in, joins once the client is ready with the given flags, and waits up to 20 s for Ready", async () => {
  const r = rig();
  await r.session.start();
  assert.deepEqual(r.client.logins, ["tok"]);
  assert.equal(r.conns.length, 0, "no join before the client is ready");
  r.client.emit("ready");
  await tick();
  assert.equal(r.conns.length, 1);
  assert.equal(r.joinOpts[0]!.channelId, "chan");
  assert.equal(r.joinOpts[0]!.guildId, "g1");
  assert.equal(r.joinOpts[0]!.selfMute, true);
  assert.equal(r.joinOpts[0]!.selfDeaf, false);
  assert.deepEqual(r.enters[0], [VoiceConnectionStatus.Ready, 20_000]);
  assert.equal(r.members.fetched, 1, "members fetched when asked for");
  await r.session.stop();
});

// @spec SHARED-DVS-002
test("a failed login rejects start() with the login error", async () => {
  const r = rig({ loginError: new Error("TOKEN_INVALID") });
  await assert.rejects(r.session.start(), /TOKEN_INVALID/);
  assert.equal(r.conns.length, 0);
});

// @spec SHARED-DVS-005
test("when the connection reaches Ready, isReady() turns true and onConnected runs", async () => {
  const r = rig();
  await r.session.start();
  assert.equal(r.session.isReady(), false);
  r.client.emit("ready");
  await tick();
  assert.equal(r.session.isReady(), true);
  assert.deepEqual(r.events, ["connected"]);
  await r.session.stop();
});

// @spec SHARED-DVS-004
test("a failed join destroys the half-open connection, reports onJoinFailed(err, attempt) and retries with a doubling delay up to the cap", async () => {
  const r = rig({ failJoins: 3 });
  await r.session.start();
  r.client.emit("ready");
  await until(() => r.events.includes("connected"));
  assert.deepEqual(r.events, ["failed:1", "failed:2", "failed:3", "connected"]);
  assert.deepEqual(r.sleeps, [5000, 10_000, 20_000]);
  assert.deepEqual(r.conns.map((c) => c.destroyed), [true, true, true, false]);
  assert.equal(r.session.isReady(), true);
  await r.session.stop();
});

// @spec SHARED-DVS-004
test("the retry delay is capped at the configured maximum", async () => {
  const r = rig({ failJoins: 6 });
  await r.session.start();
  r.client.emit("ready");
  await until(() => r.events.includes("connected"));
  assert.deepEqual(r.sleeps, [5000, 10_000, 20_000, 40_000, 60_000, 60_000]);
  await r.session.stop();
});

// @spec SHARED-DVS-004
test("a channel that is not a voice channel fails the join like any other failure", async () => {
  const r = rig({ notVoice: true });
  await r.session.start();
  r.client.emit("ready");
  await tick(); await tick();
  assert.ok(r.events.includes("failed:1"));
  await r.session.stop();
});

// @spec SHARED-DVS-003, SHARED-DVS-006
test("a Disconnected connection that does not recover within 5 s marks the session not ready, reports it, destroys the connection and rejoins after 5 s with the attempt count back at 1", async () => {
  const r = rig({ enters: async (_c, status) => { if (status !== VoiceConnectionStatus.Ready) throw new Error("no recovery"); } });
  await r.session.start();
  r.client.emit("ready");
  await tick();
  assert.equal(r.session.isReady(), true);
  r.conns[0]!.emit(VoiceConnectionStatus.Disconnected);
  await tick(); await tick();
  assert.deepEqual(r.enters.filter(([s]) => s !== VoiceConnectionStatus.Ready), [[VoiceConnectionStatus.Signalling, 5000], [VoiceConnectionStatus.Connecting, 5000]]);
  assert.equal(r.conns[0]!.destroyed, true);
  assert.ok(r.events.includes("disconnected"));
  assert.equal(r.sleeps[0], 5000, "first delay 5 s");
  assert.equal(r.conns.length, 2, "rejoined");
  assert.equal(r.session.isReady(), true);
  await r.session.stop();
});

// @spec SHARED-DVS-003
test("a Disconnected connection that moves to Signalling or Connecting is left alone", async () => {
  const r = rig();
  await r.session.start();
  r.client.emit("ready");
  await tick();
  r.conns[0]!.emit(VoiceConnectionStatus.Disconnected);
  await tick(); await tick();
  assert.equal(r.conns.length, 1);
  assert.equal(r.session.isReady(), true);
  assert.deepEqual(r.events, ["connected"]);
  await r.session.stop();
});

// @spec SHARED-DVS-006
test("concurrent join-loop starts share one running loop", async () => {
  let release!: () => void;
  const gate = new Promise<void>((res) => { release = res; });
  const r = rig({ enters: async (_c, status) => { if (status === VoiceConnectionStatus.Ready) await gate; } });
  await r.session.start();
  r.client.emit("ready");
  r.client.emit("ready");
  await tick();
  assert.equal(r.conns.length, 1);
  release();
  await tick();
  await r.session.stop();
});

// @spec SHARED-DVS-007
test("stop() ends the join loop, destroys the connection and the client, and a second stop does nothing", async () => {
  const r = rig();
  await r.session.start();
  r.client.emit("ready");
  await tick();
  await r.session.stop();
  assert.equal(r.conns[0]!.destroyed, true);
  assert.equal(r.client.destroyed, 1);
  await r.session.stop();
  assert.equal(r.client.destroyed, 1);
});

// @spec SHARED-DVS-007
test("stop() while the join loop is retrying ends it", async () => {
  const r = rig({ failJoins: 1000 });
  await r.session.start();
  r.client.emit("ready");
  await tick();
  await r.session.stop();
  const attempts = r.conns.length;
  await tick();
  assert.equal(r.conns.length, attempts, "no attempts after stop");
});
