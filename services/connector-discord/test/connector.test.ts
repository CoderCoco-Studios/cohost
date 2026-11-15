// Heartbeat checks run at least once per HEARTBEAT_INTERVAL_MS; keep the tests quick.
process.env.HEARTBEAT_INTERVAL_MS = "40";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { GatewayIntentBits } from "discord.js";
import { VoiceConnectionStatus } from "@discordjs/voice";
import { encodeFrame, decodeFrame, type Frame, type Registration, type Bus } from "@cohost/bus";
import { runService, wavWrap } from "@cohost/shared";
import { FakeBus, event, recordingLog, testConfig, waitFor } from "@cohost/testing";
import { createConnectorService } from "../src/service.js";

/** A bus with an in-memory registry, audio streams and a stop log. */
class ConnBus extends FakeBus {
  regs = new Map<string, Registration>();
  /** Every registration written, in order. */
  history: Registration[] = [];
  frames: { dir: string; tag: string; frame: Frame }[] = [];
  events: string[] = [];
  failFrames = false;
  groups: string[] = [];
  subscribeOpts?: unknown;
  /** The `inject.request` handler the connector subscribed. */
  handler?: (ev: never) => void;
  private handlers = new Map<string, (d: ReturnType<typeof decodeFrame>, id: string) => void>();
  private ends: (() => void)[] = [];
  async writeRegistration(reg: Registration) { this.history.push(structuredClone(reg)); this.regs.set(reg.id, structuredClone(reg)); }
  async readRegistration(id: string) { return this.regs.get(id); }
  async listConnectors() { return [...this.regs.values()]; }
  async deleteRegistration(id: string) { this.events.push("delete-registration"); this.regs.delete(id); }
  async publishFrame(dir: string, tag: string, frame: Frame) {
    if (this.failFrames) throw new Error("redis down");
    this.frames.push({ dir, tag, frame });
    return "1-0";
  }
  tailAudio(dir: string, tag: string, handler: (d: ReturnType<typeof decodeFrame>, id: string) => void) {
    this.handlers.set(`${dir}.${tag}`, handler);
    return new Promise<void>((r) => this.ends.push(r));
  }
  /** Deliver a frame as it would arrive from Redis. */
  feed(dir: string, tag: string, f: Frame) { this.handlers.get(`${dir}.${tag}`)?.(decodeFrame(encodeFrame(f)), "1-0"); }
  feedRaw(dir: string, tag: string, fields: (string | Buffer)[]) { this.handlers.get(`${dir}.${tag}`)?.(decodeFrame(fields), "1-0"); }
  hasTail(dir: string, tag: string) { return this.handlers.has(`${dir}.${tag}`); }
  async resetGroup(g: string): Promise<void> { this.groups.push(g); }
  subscribe(opts: unknown, handler: (ev: never) => void): Promise<void> {
    this.subscribeOpts = opts; this.handler = handler;
    return new Promise<void>((r) => this.ends.push(r));
  }
  stop() { this.events.push("bus-stop"); for (const e of this.ends) e(); }
  lastHealth() { return this.health[this.health.length - 1]; }
}

class FakeConnection extends EventEmitter {
  destroyed = false;
  subscribed: unknown[] = [];
  subs: { userId: string; stream: PassThrough }[] = [];
  receiver = {
    speaking: new EventEmitter(),
    subscribe: (userId: string) => { const stream = new PassThrough(); this.subs.push({ userId, stream }); return stream; },
  };
  destroy() { this.destroyed = true; }
  subscribe(player: unknown) { this.subscribed.push(player); }
}
class FakePlayer extends EventEmitter {
  played: { stream: PassThrough; chunks: Buffer[] }[] = [];
  stops = 0;
  /** The slice of the real player's `state` the connector reads. */
  state = { status: "idle" };
  play(resource: { stream: PassThrough; chunks: Buffer[] }) { this.played.push(resource); this.state.status = "playing"; }
  stop() { this.stops++; this.state.status = "idle"; }
  /** The player drained what it was given. */
  drain() { this.state.status = "idle"; }
}

const mono = (n = 640) => Buffer.alloc(n, 3);
const outFrame = (seq: number, over: Partial<Frame> = {}): Frame => ({ epoch: 5, seq, rate: 48000, ch: 2, pcm: Buffer.alloc(3840, seq + 1), utt: "u1", ...over });

interface RigOpts {
  enabled?: boolean; token?: string; guild?: string; channel?: string; loginError?: Error; failJoins?: number;
  users?: Record<string, { bot: boolean }>; fetchable?: Record<string, { bot: boolean }>;
  others?: Registration[];
}

function rig(o: RigOpts = {}) {
  const bus = new ConnBus();
  for (const r of o.others ?? []) bus.regs.set(r.id, r);
  const rec = recordingLog();
  const cfg = testConfig({ connections: { discord: { enabled: o.enabled ?? true, guild_id: o.guild ?? "g1", voice_channel_id: o.channel ?? "chan" } } });
  const channel = { id: "chan", name: "General", isVoiceBased: () => true, guild: { members: { cache: new Map([["u1", { displayName: "Ann" }]]) } } };
  const guild = { id: "g1", channels: { fetch: async () => channel }, members: { fetch: async () => undefined }, voiceAdapterCreator: {} };
  const users = {
    cache: { get: (id: string) => o.users?.[id] },
    fetched: [] as string[],
    fetch: async (id: string) => { users.fetched.push(id); const u = o.fetchable?.[id]; if (!u) throw new Error("unknown user"); return u; },
  };
  const client = Object.assign(new EventEmitter(), {
    logins: [] as string[], destroyed: 0, user: { id: "me", tag: "bot#1" }, users,
    guilds: { fetch: async () => guild },
    login: async (t: string) => { client.logins.push(t); if (o.loginError) throw o.loginError; },
    destroy: async () => { client.destroyed++; bus.events.push("client-destroy"); },
  });
  const intents: unknown[] = [];
  const joins: Record<string, unknown>[] = [];
  const conns: FakeConnection[] = [];
  const sleeps: number[] = [];
  let joinsToFail = o.failJoins ?? 0;
  const player = new FakePlayer();
  const decoders: PassThrough[] = [];
  let shutdown: (() => void | Promise<void>) | undefined;
  const exits: number[] = [];
  const svc = createConnectorService({
    env: { DISCORD_TOKEN: o.token ?? "tok" }, intervalMs: 60_000, refreshMs: 10,
    createPlayer: () => player as never,
    createResource: (stream) => { const r = { stream, chunks: [] as Buffer[] }; stream.on("data", (c: Buffer) => r.chunks.push(c)); return r as never; },
    createDecoder: () => { const d = new PassThrough(); decoders.push(d); return d; },
    voice: {
      createClient: (i) => { intents.push(...i); return client as never; },
      joinVoiceChannel: ((jo: Record<string, unknown>) => { joins.push(jo); const c = new FakeConnection(); conns.push(c); return c; }) as never,
      entersState: (async (_c: unknown, status: string) => {
        if (status === VoiceConnectionStatus.Ready && joinsToFail > 0) { joinsToFail--; throw new Error("not ready"); }
        if (status !== VoiceConnectionStatus.Ready) throw new Error("did not recover");
      }) as never,
      sleep: async (ms) => { sleeps.push(ms); await new Promise((r) => setImmediate(r)); },
    },
  });
  const done = runService<Bus>({
    service: "connector-discord", ...svc,
    loadConfig: () => cfg, createBus: () => bus as never, log: rec.log,
    onShutdown: (fn) => { shutdown = fn; }, exit: (c) => { exits.push(c); },
  });
  const stop = async () => { await shutdown?.(); };
  return { bus, rec, client, intents, joins, conns, sleeps, player, decoders, done, stop, exits, users, svc, reg: () => bus.regs.get("discord") };
}

/** Started, logged in and joined. */
async function up(o: RigOpts = {}) {
  const r = rig(o);
  await r.done;
  r.client.emit("ready");
  await waitFor(() => r.reg()?.capabilities.every((c) => c.ready) === true, "registered ready");
  return r;
}

// @spec CONN-DISC-001, CONN-DISC-003, CONN-DISC-005, CONN-HLTH-001, CONN-HLTH-002
test("logs in with DISCORD_TOKEN, joins undeafened and unmuted with the three intents, registers both capabilities ready and reports ready", async () => {
  const r = rig();
  await r.done;
  // registered before the join resolves: not ready, starting
  assert.equal(r.reg()?.state, "starting");
  assert.deepEqual(r.reg()?.capabilities.map((c) => c.ready), [false, false]);
  r.client.emit("ready");
  await waitFor(() => r.reg()?.state === "ready", "ready registration");
  assert.deepEqual(r.client.logins, ["tok"]);
  assert.deepEqual(r.intents, [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMembers]);
  assert.equal(r.joins.length, 1, "the only voice connection");
  assert.equal(r.joins[0]!.guildId, "g1");
  assert.equal(r.joins[0]!.channelId, "chan");
  assert.equal(r.joins[0]!.selfDeaf, false);
  assert.equal(r.joins[0]!.selfMute, false);
  assert.deepEqual(r.conns[0]!.subscribed, [r.player]);
  const reg = r.reg()!;
  assert.equal(reg.id, "discord");
  assert.deepEqual(reg.capabilities.map((c) => [c.cap, c.tag, c.format, c.ready]), [
    ["audio-in", "discord", { rate: 16000, channels: 1 }, true],
    ["audio-out", "discord", { rate: 48000, channels: 2 }, true],
  ]);
  await waitFor(() => r.bus.lastHealth()?.state === "ready" && r.bus.lastHealth()?.deps["audio-out"] === "ok", "ready heartbeat");
  const hb = r.bus.lastHealth()!;
  assert.equal(hb.service, "connector-discord");
  assert.equal(hb.mode, "live");
  assert.deepEqual(hb.deps, { discord: "ok", "audio-in": "ok", "audio-out": "ok" });
  assert.match(hb.detail ?? "", /dropped 0/);
  assert.ok(r.bus.health.some((h) => h.state === "starting"), "starting until the first join resolves");
  await r.stop();
});

// @spec CONN-DISC-001
test("a failed login is logged, withdraws the registration and exits with code 1", async () => {
  const r = rig({ loginError: new Error("bad token") });
  await r.done;
  assert.deepEqual(r.exits, [1]);
  assert.ok(r.rec.lines.some((l) => l.level === "error" && l.msg === "discord login failed"));
  assert.equal(r.reg(), undefined);
});

// @spec CONN-DISC-002
test("an unset DISCORD_TOKEN idles degraded: no client, nothing registered, an error logged, detail names the variable", async () => {
  const r = rig({ token: "" });
  await r.done;
  assert.equal(r.client.logins.length, 0);
  assert.equal(r.intents.length, 0, "no Discord client created");
  assert.equal(r.reg(), undefined);
  assert.equal(r.exits.length, 0);
  assert.ok(r.rec.lines.some((l) => l.level === "error" && String(l.msg).includes("DISCORD_TOKEN is not set")));
  await waitFor(() => r.bus.lastHealth()?.state === "degraded", "degraded heartbeat");
  assert.equal(r.bus.lastHealth()?.detail, "DISCORD_TOKEN is not set");
  assert.equal(r.bus.lastHealth()?.mode, "live");
  await r.stop();
});

// @spec CONN-DISC-011, CONN-HLTH-001
test("connections.discord.enabled false idles: no client, nothing registered, mode off and state ready", async () => {
  const r = rig({ enabled: false });
  await r.done;
  assert.equal(r.intents.length, 0);
  assert.equal(r.reg(), undefined);
  assert.equal(r.bus.hasTail("out", "discord"), false);
  await waitFor(() => r.bus.lastHealth()?.state === "ready", "ready heartbeat");
  assert.equal(r.bus.lastHealth()?.mode, "off");
  await r.stop();
});

// @spec CONN-DISC-003, CONN-DISC-004, CONN-HLTH-002
test("a failing join (unset key, then a join that does not reach Ready) stays registered not ready and degraded, then recovers by itself", async () => {
  const r = rig({ channel: "", failJoins: 0 });
  await r.done;
  r.client.emit("ready");
  await waitFor(() => r.sleeps.length >= 2, "two retries");
  assert.deepEqual(r.sleeps.slice(0, 2), [5000, 10000]);
  assert.equal(r.reg()?.state, "degraded");
  assert.match(r.reg()!.detail, /connections\.discord\.voice_channel_id is not set/);
  assert.deepEqual(r.reg()?.capabilities.map((c) => c.ready), [false, false]);
  await waitFor(() => r.bus.lastHealth()?.state === "degraded" && r.bus.lastHealth()?.deps.discord === "down", "degraded heartbeat");
  assert.match(r.bus.lastHealth()!.detail ?? "", /voice_channel_id is not set.*dropped 0/);
  assert.equal(r.joins.length, 0);
  await r.stop();

  const s = rig({ failJoins: 1 });
  await s.done;
  s.client.emit("ready");
  await waitFor(() => s.reg()?.capabilities.every((c) => c.ready) === true, "ready after a retry");
  assert.equal(s.conns[0]!.destroyed, true, "the half-open connection was destroyed");
  assert.equal(s.reg()?.state, "ready");
  await s.stop();
});

// @spec CONN-DISC-004
test("when the connection drops and cannot recover, both capabilities go not ready and return when it is Ready again", async () => {
  const r = await up();
  r.conns[0]!.emit(VoiceConnectionStatus.Disconnected);
  await waitFor(() => r.joins.length === 2 && r.reg()?.capabilities.every((c) => c.ready) === true, "ready again");
  const down = r.bus.history.find((h) => h.capabilities.every((c) => !c.ready) && h.state === "degraded");
  assert.ok(down, "a registration with both capabilities not ready was written while recovering");
  assert.ok(r.player.stops >= 1, "playback dropped");
  assert.equal(r.joins.length, 2, "one rejoin, owned by the connector");
  await r.stop();
});

// @spec CONN-DISC-006, CONN-DISC-007
test("a human speaker's audio is decoded, converted to 16 kHz mono and written as 20 ms frames with spk and the guild display name", async () => {
  const r = await up({ users: { u1: { bot: false } } });
  const conn = r.conns[0]!;
  conn.receiver.speaking.emit("start", "u1");
  await waitFor(() => conn.subs.length === 1, "subscription");
  assert.equal(r.decoders.length, 1);
  // 3 decoded 20 ms frames (48 kHz stereo = 3840 bytes) delivered in odd-sized chunks
  const pcm = Buffer.alloc(3840 * 3, 2);
  r.decoders[0]!.write(pcm.subarray(0, 5000));
  r.decoders[0]!.write(pcm.subarray(5000));
  await waitFor(() => r.bus.frames.length === 3, "three frames");
  const frames = r.bus.frames.map((f) => f.frame);
  assert.ok(r.bus.frames.every((f) => f.dir === "in" && f.tag === "discord"));
  for (const f of frames) { assert.equal(f.rate, 16000); assert.equal(f.ch, 1); assert.equal(f.pcm.length, 640); assert.equal(f.spk, "u1"); assert.equal(f.name, "Ann"); }
  assert.deepEqual(frames.map((f) => f.seq), [0, 1, 2]);
  assert.equal(new Set(frames.map((f) => f.epoch)).size, 1);
  await r.stop();
});

// @spec CONN-DISC-006, CONN-DISC-007
test("bots (cached or fetched) and the connector's own account are never read, an unknown account is fetched first and an unfetchable one skipped, and a speaker already captured gets one subscription", async () => {
  const r = await up({ users: { bot1: { bot: true } }, fetchable: { fresh: { bot: false }, bot2: { bot: true } } });
  const conn = r.conns[0]!;
  const speak = (id: string) => conn.receiver.speaking.emit("start", id);
  speak("bot1"); speak("bot2"); speak("me"); speak("ghost");
  speak("fresh"); speak("fresh");
  await waitFor(() => r.users.fetched.length >= 3, "fetches");
  await new Promise((res) => setTimeout(res, 20));
  assert.deepEqual(conn.subs.map((s) => s.userId), ["fresh"], "only the fetched human, once");
  assert.deepEqual(r.users.fetched.sort(), ["bot2", "fresh", "ghost"].sort(), "bot1 was cached, me never looked up");
  // a speaker that ended can be captured again
  r.decoders[0]!.end();
  await waitFor(() => { speak("fresh"); return conn.subs.length === 2; }, "second subscription after the first ended");
  await r.stop();
});

// @spec CONN-DISC-007
test("a decoder error removes the speaker from the capture set and logs 'decoder error'", async () => {
  const r = await up({ users: { u1: { bot: false } } });
  const conn = r.conns[0]!;
  conn.receiver.speaking.emit("start", "u1");
  await waitFor(() => conn.subs.length === 1, "subscription");
  r.decoders[0]!.emit("error", new Error("corrupt"));
  assert.ok(r.rec.lines.some((l) => l.level === "warn" && l.msg === "decoder error"));
  await waitFor(() => { conn.receiver.speaking.emit("start", "u1"); return conn.subs.length === 2; }, "capturable again");
  await r.stop();
});

// @spec CONN-DISC-008
test("while Ready, audio.out.discord frames are played in seq order on one player as one stream per utterance; a gap plays what is present; a late frame is dropped", async () => {
  const r = await up();
  assert.equal(r.bus.hasTail("out", "discord"), true);
  r.bus.feed("out", "discord", outFrame(0));
  r.bus.feed("out", "discord", outFrame(1));
  r.bus.feed("out", "discord", outFrame(3)); // seq 2 lost
  r.bus.feed("out", "discord", outFrame(2)); // arrives late
  r.bus.feed("out", "discord", outFrame(4, { last: true }));
  r.bus.feed("out", "discord", outFrame(0, { epoch: 6, utt: "u2", last: true }));
  assert.equal(r.player.played.length, 2, "one resource per utterance");
  await waitFor(() => r.player.played[0]!.chunks.length === 4, "chunks");
  assert.deepEqual(r.player.played[0]!.chunks.map((c) => c[0]), [1, 2, 4, 5]);
  assert.ok(r.player.played[0]!.stream.writableEnded, "last ends the utterance");
  await r.stop();
});

// @spec CONN-DISC-008, CONN-ISO-002
test("a player that never drains cannot grow memory without bound: frames over the buffer cap are dropped and counted", async () => {
  const r = await up();
  const resource = (): { stream: PassThrough } => r.player.played[0]!;
  // 10 s of 48 kHz stereo is 1.92 MB = 500 frames; the player never reads
  r.player.played.length = 0;
  r.player.play = (res) => { res.stream.pause(); r.player.played.push(res); };
  for (let i = 0; i < 700; i++) r.bus.feed("out", "discord", outFrame(i, { utt: "long" }));
  assert.ok(resource().stream.readableLength + resource().stream.writableLength <= 1_920_000 + 3840);
  await waitFor(() => /dropped \d+/.test(r.bus.lastHealth()?.detail ?? "") && !/dropped 0/.test(r.bus.lastHealth()?.detail ?? ""), "dropped reported");
  await r.stop();
});

// @spec CONN-BP-005
test("while the connection is not Ready, audio.out frames are discarded and counted, not played", async () => {
  const r = rig({ channel: "" });
  await r.done;
  r.client.emit("ready");
  await waitFor(() => r.reg()?.state === "degraded", "degraded");
  r.bus.feed("out", "discord", outFrame(0));
  r.bus.feed("out", "discord", outFrame(1));
  assert.equal(r.player.played.length, 0);
  await waitFor(() => /dropped 2/.test(r.bus.lastHealth()?.detail ?? ""), "discarded counted");
  await r.stop();
});

// @spec CONN-BP-003, CONN-BP-006, CONN-AUD-003
test("seq gaps within an epoch are added to a loss counter reported in the heartbeat detail; a new epoch resets the baseline; malformed and wrong-format frames are dropped and counted", async () => {
  const r = await up();
  r.bus.feed("out", "discord", outFrame(0));
  r.bus.feed("out", "discord", outFrame(3)); // lost 2
  r.bus.feed("out", "discord", outFrame(0, { epoch: 9 })); // restart: no loss
  r.bus.feed("out", "discord", outFrame(1, { epoch: 9, rate: 24000 })); // wrong format
  r.bus.feedRaw("out", "discord", ["v", "2", "pcm", Buffer.alloc(4)]); // malformed
  await waitFor(() => /lost 2, dropped 2/.test(r.bus.lastHealth()?.detail ?? ""), "loss reported");
  assert.equal(r.bus.lastHealth()?.state, "ready", "loss alone is not degraded");
  await r.stop();
});

// @spec CONN-HLTH-002, CONN-HLTH-001
test("a tag another live connector serves is left out of the registration: degraded with the conflict named, that dependency down", async () => {
  const other: Registration = {
    v: 1, id: "other", kind: "x", version: "1", instance: "i", pid: 1, startedAt: 1, intervalMs: 5000, state: "ready", detail: "",
    capabilities: [{ cap: "audio-out", tag: "discord", format: { rate: 48000, channels: 2 }, ready: true, transport: "stream" }],
  };
  const s = rig({ others: [other] });
  await s.done;
  s.client.emit("ready");
  await waitFor(() => s.bus.lastHealth()?.state === "degraded" && s.bus.lastHealth()?.deps["audio-out"] === "down" && s.bus.lastHealth()?.deps["audio-in"] === "ok", "conflict reported");
  assert.deepEqual(s.reg()?.capabilities.map((c) => c.cap), ["audio-in"]);
  assert.match(s.bus.lastHealth()!.detail ?? "", /sink discord is served by other/);
  assert.equal(s.bus.lastHealth()?.deps["audio-in"], "ok");
  await s.stop();
});

// @spec CONN-ISO-002, CONN-BP-001
test("a failing frame write drops the frame and keeps the connection and the registration", async () => {
  const r = await up({ users: { u1: { bot: false } } });
  r.bus.failFrames = true;
  const conn = r.conns[0]!;
  conn.receiver.speaking.emit("start", "u1");
  await waitFor(() => conn.subs.length === 1, "subscription");
  r.decoders[0]!.write(Buffer.alloc(3840 * 2));
  await waitFor(() => /dropped 2/.test(r.bus.lastHealth()?.detail ?? ""), "drops counted");
  assert.equal(conn.destroyed, false);
  assert.ok(r.reg(), "still registered");
  assert.equal(r.bus.lastHealth()?.state, "ready");
  await r.stop();
});

// @spec CONN-DISC-009
test("a shutdown signal runs one sequence: registration deleted, voice connection and client destroyed, then the bus stopped", async () => {
  const r = await up();
  await r.stop();
  assert.deepEqual(r.bus.events, ["delete-registration", "client-destroy", "bus-stop"]);
  assert.equal(r.reg(), undefined);
  assert.equal(r.conns[0]!.destroyed, true);
  assert.equal(r.client.destroyed, 1);
});

// @spec CONN-DISC-010
test("the connector publishes no domain event", async () => {
  const r = await up({ users: { u1: { bot: false } } });
  r.conns[0]!.receiver.speaking.emit("start", "u1");
  await waitFor(() => r.conns[0]!.subs.length === 1, "subscription");
  r.decoders[0]!.write(Buffer.alloc(3840));
  r.bus.feed("out", "discord", outFrame(0, { last: true }));
  await waitFor(() => r.bus.frames.length === 1, "frame");
  assert.deepEqual(r.bus.published, []);
  await r.stop();
});

// ---- flush (barge-in)

const flushOut = (seq: number, over: Record<string, unknown> = {}): Frame => ({ epoch: 5, seq, rate: 48000, ch: 2, utt: "u1", flush: true, ...over } as unknown as Frame);

// @spec CONN-DISC-012, CONN-FLUSH-001
test("the audio-out capability is registered with flush true and audio-in without it", async () => {
  const r = await up();
  const caps = r.reg()!.capabilities as unknown as { cap: string; flush?: boolean }[];
  assert.equal(caps.find((c) => c.cap === "audio-out")!.flush, true);
  assert.ok(!caps.find((c) => c.cap === "audio-in")!.flush);
  await r.stop();
});

// @spec CONN-DISC-012, CONN-FLUSH-002
test("a flush frame while Ready stops the player, ends and discards the stream with its buffered frames, and counts none of them as dropped", async () => {
  const r = await up();
  r.bus.feed("out", "discord", outFrame(0));
  r.bus.feed("out", "discord", outFrame(1));
  r.bus.feed("out", "discord", outFrame(2));
  assert.equal(r.player.played.length, 1);
  const first = r.player.played[0]!;
  const stopsBefore = r.player.stops;
  r.bus.feed("out", "discord", flushOut(3));
  assert.equal(r.player.stops, stopsBefore + 1, "the audio player is stopped");
  assert.ok(first.stream.destroyed || first.stream.writableEnded, "the stream it was feeding is discarded");
  assert.equal(first.stream.readableLength, 0, "its buffered frames are gone");
  await waitFor(() => /lost 0, dropped 0/.test(r.bus.lastHealth()?.detail ?? ""), "discarded frames are neither dropped nor lost");
  await r.stop();
});

// @spec CONN-DISC-012, CONN-FLUSH-003
test("after a flush the next line the connector reads starts on a fresh stream, in seq order, from an empty buffer", async () => {
  const r = await up();
  r.bus.feed("out", "discord", outFrame(0));
  r.bus.feed("out", "discord", outFrame(1));
  r.bus.feed("out", "discord", flushOut(2));
  r.bus.feed("out", "discord", outFrame(3, { utt: "u2" }));
  r.bus.feed("out", "discord", outFrame(4, { utt: "u2", last: true }));
  assert.equal(r.player.played.length, 2, "a new resource for the new line");
  assert.notEqual(r.player.played[1]!.stream, r.player.played[0]!.stream);
  await waitFor(() => r.player.played[1]!.chunks.length === 2, "chunks of the new line");
  assert.deepEqual(r.player.played[1]!.chunks.map((c) => c[0]), [4, 5], "only the new line's frames");
  await r.stop();
});

// @spec CONN-FLUSH-003
test("a flush frame read while nothing is playing or buffered changes nothing", async () => {
  const r = await up();
  r.bus.feed("out", "discord", flushOut(0));
  assert.equal(r.player.stops, 0);
  assert.equal(r.player.played.length, 0);
  r.bus.feed("out", "discord", outFrame(1, { utt: "u2", last: true }));
  assert.equal(r.player.played.length, 1, "the next line plays normally");
  await waitFor(() => /dropped 0/.test(r.bus.lastHealth()?.detail ?? ""), "nothing counted as dropped");
  await r.stop();
});

// @spec CONN-DISC-012, CONN-FLUSH-002
test("a flush after the line's last frame stops the player while it still plays the buffered tail", async () => {
  const r = await up();
  r.bus.feed("out", "discord", outFrame(0));
  r.bus.feed("out", "discord", outFrame(1, { last: true }));
  assert.equal(r.player.state.status, "playing", "the player still drains the finished line");
  r.bus.feed("out", "discord", flushOut(2));
  assert.equal(r.player.stops, 1, "the flush cuts the tail");
  await r.stop();
});

// @spec CONN-FLUSH-003
test("a flush after the player drained a finished line changes nothing", async () => {
  const r = await up();
  r.bus.feed("out", "discord", outFrame(0, { last: true }));
  r.player.drain();
  r.bus.feed("out", "discord", flushOut(1));
  assert.equal(r.player.stops, 0);
  await r.stop();
});

// @spec CONN-FLUSH-004
test("a connector that never receives a flush frame plays a stopped line's written frames out as written", async () => {
  const r = await up();
  r.bus.feed("out", "discord", outFrame(0));
  r.bus.feed("out", "discord", outFrame(1));
  r.bus.feed("out", "discord", outFrame(2, { utt: "u2", last: true })); // the producer just stopped writing u1: no flush frame
  await waitFor(() => r.player.played[0]!.chunks.length === 2, "u1's frames");
  assert.equal(r.player.stops, 0, "nothing is cut");
  assert.deepEqual(r.player.played[0]!.chunks.map((c) => c[0]), [1, 2]);
  await r.stop();
});

// @spec CONN-DISC-013
test("an audio player error is logged as the warning 'player error' with the error's message", async () => {
  const r = await up();
  r.player.emit("error", new Error("opus exploded"));
  const warn = r.rec.lines.find((l) => l.level === "warn" && l.msg === "player error");
  assert.ok(warn, "warning logged");
  assert.deepEqual(warn!.obj, { err: "opus exploded" });
  await r.stop();
});

// ---- test injection (CONN-INJ)

const UPLOAD = "0123456789abcdef0123456789abcdef";
/** A 16 kHz mono WAV of `ms` milliseconds of non-silent samples. */
const clip = (ms: number): Buffer => wavWrap(Buffer.alloc((16000 * ms) / 1000 * 2, 7), 16000, 1);
/** Sends one injected clip to the connector and returns its `inject.result`. */
async function inject(r: { bus: ConnBus }, bytes: Buffer, over: Record<string, unknown> = {}) {
  const id = `inj-${r.bus.of("inject.result").length}`;
  r.bus.uploads.set(UPLOAD, { bytes, ttlMs: 1000 });
  r.bus.handler!(event("inject.request", { id, target: "connector-discord", kind: "audio", uploadId: UPLOAD, contentType: "audio/wav", remember: false, ...over }) as never);
  await waitFor(() => r.bus.of("inject.result").some((x) => x.id === id), "inject.result");
  return r.bus.of("inject.result").find((x) => x.id === id)!;
}

// @spec CONN-INJ-001
test("every plan subscribes the connector group to inject.request at start mode latest, before it reports ready, and ignores another target", async () => {
  for (const o of [{}, { enabled: false }, { token: "" }]) {
    const r = rig(o);
    await r.done;
    assert.deepEqual(r.bus.groups, ["connector-discord"], JSON.stringify(o));
    assert.deepEqual(r.bus.subscribeOpts, { group: "connector-discord", types: ["inject.request"], start: "latest" });
    r.bus.handler!(event("inject.request", { id: "x", target: "ears", kind: "audio", uploadId: UPLOAD, remember: false }) as never);
    await new Promise((x) => setTimeout(x, 20));
    assert.deepEqual(r.bus.of("inject.result"), [], "a request for another target is not answered");
    await r.stop();
  }
});

// @spec CONN-INJ-001, CONN-INJ-002, CONN-INJ-003
test("while Ready, an injected 16 kHz mono clip is converted to 48 kHz stereo 20 ms frames, played as one stream on the player, and reported", async () => {
  const r = await up();
  const out = await inject(r, clip(100));
  assert.equal(out.ok, true);
  assert.match(out.detail!, /played 5 frames \(100 ms\)/);
  assert.equal(r.player.played.length, 1);
  await waitFor(() => r.player.played[0]!.chunks.length === 5, "chunks");
  assert.deepEqual(r.player.played[0]!.chunks.map((c) => c.length), [3840, 3840, 3840, 3840, 3840]);
  assert.ok(r.player.played[0]!.stream.writableEnded, "the last frame ends the stream");
  assert.deepEqual(r.bus.frames, [], "the clip is played, not written to any audio stream");
  await r.stop();
});

// @spec CONN-INJ-002
test("an injected clip is a line like any other: a flush frame stops it, and a second clip plays after the first", async () => {
  const r = await up();
  await inject(r, clip(100));
  assert.equal(r.player.stops, 0);
  r.bus.feed("out", "discord", { epoch: 9, seq: 0, rate: 48000, ch: 2, pcm: Buffer.alloc(0), utt: "m", flush: true });
  assert.equal(r.player.stops, 1, "the flush stops the injected line");
  const again = await inject(r, clip(100));
  assert.equal(again.ok, true);
  assert.equal(r.player.played.length, 2, "the next clip starts a fresh stream");
  await r.stop();
});

// @spec CONN-INJ-004, CONN-DISC-011
test("where Discord is off an injected clip runs through the playout against a player that sends nothing and the answer says what it would have played; nothing is registered", async () => {
  const r = rig({ enabled: false });
  await r.done;
  const out = await inject(r, clip(100));
  assert.equal(out.ok, true);
  assert.match(out.detail!, /Discord is off/);
  assert.match(out.detail!, /would have played 5 frames \(100 ms\)/);
  assert.equal(r.player.played.length, 0, "no real player is touched");
  assert.equal(r.reg(), undefined);
  assert.equal(r.bus.hasTail("out", "discord"), false);
  await waitFor(() => r.bus.lastHealth()?.state === "ready", "ready heartbeat");
  assert.equal(r.bus.lastHealth()?.mode, "off");
  const longer = await inject(r, clip(10_000));
  assert.equal(longer.ok, true, "a clip of exactly the 10 s cap is played");
  await r.stop();
});

// @spec CONN-INJ-005
test("a clip that is not a 16-bit PCM WAV, holds no samples or is longer than 10 s is answered not ok with the reason and plays nothing", async () => {
  const r = await up();
  const not = await inject(r, Buffer.from("this is not a wav file at all"));
  assert.equal(not.ok, false);
  assert.match(not.detail!, /RIFF\/WAVE/);
  const empty = await inject(r, wavWrap(Buffer.alloc(0), 16000, 1));
  assert.equal(empty.ok, false);
  assert.match(empty.detail!, /no samples/);
  const long = await inject(r, clip(10_020));
  assert.equal(long.ok, false);
  assert.match(long.detail!, /longer than 10 s/);
  assert.equal(r.player.played.length, 0);
  await r.stop();
});

// @spec CONN-INJ-006, CONN-DISC-002
test("with DISCORD_TOKEN unset, or while the voice connection is not Ready, an injected clip is answered not ok with the heartbeat's reason", async () => {
  const noToken = rig({ token: "" });
  await noToken.done;
  const a = await inject(noToken, clip(100));
  assert.equal(a.ok, false);
  assert.equal(a.detail, "DISCORD_TOKEN is not set");
  await noToken.stop();

  const joining = rig({ failJoins: 99 });
  await joining.done;
  joining.client.emit("ready");
  await waitFor(() => joining.reg()?.state === "degraded", "degraded");
  const b = await inject(joining, clip(100));
  assert.equal(b.ok, false);
  assert.match(b.detail!, /voice join failed|voice connection is not ready/);
  assert.equal(joining.player.played.length, 0);
  await joining.stop();
});
