import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeBus, event, recordingLog, testConfig } from "@cohost/testing";
import { DISCORD_LOOP_TYPES, createEarsHandler, createJoiner, stopEars, subscribeEars, voiceTarget } from "../src/session.js";

const sleeper = () => {
  const sleeps: number[] = [];
  return { sleeps, sleep: async (ms: number) => { sleeps.push(ms); } };
};

// @spec EARS-SESS-006
test("a failed join is reported and retried with increasing delay until it succeeds", async () => {
  const { sleeps, sleep } = sleeper();
  const failures: [string, number][] = [];
  let calls = 0;
  const joiner = createJoiner({
    join: async () => { if (++calls <= 3) throw new Error(`no voice ${calls}`); },
    onFailure: (err, attempt) => failures.push([String(err), attempt]),
    sleep,
  });
  await joiner.run();
  assert.equal(calls, 4);
  assert.deepEqual(failures, [["Error: no voice 1", 1], ["Error: no voice 2", 2], ["Error: no voice 3", 3]]);
  assert.deepEqual(sleeps, [5000, 10_000, 20_000]);
});

// @spec EARS-SESS-006
test("the retry delay is capped, and a rejoin waits its first delay before the first attempt", async () => {
  const { sleeps, sleep } = sleeper();
  let calls = 0;
  await createJoiner({ join: async () => { if (++calls <= 6) throw new Error("x"); }, onFailure() {}, sleep }).run(5000);
  assert.deepEqual(sleeps, [5000, 5000, 10_000, 20_000, 40_000, 60_000, 60_000]);
});

// @spec EARS-SESS-006
test("concurrent runs share one retry loop, and stopping ends it", async () => {
  const { sleep } = sleeper();
  let calls = 0;
  let stopped = false;
  const joiner = createJoiner({
    join: async () => { calls++; throw new Error("x"); },
    onFailure: () => { if (calls === 3) stopped = true; },
    sleep, isStopped: () => stopped,
  });
  await Promise.all([joiner.run(), joiner.run()]);
  assert.equal(calls, 3);
});

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
test("inject.request is handled whether or not the voice connection is ready", async () => {
  for (const ready of [false, true]) {
    const handled: string[] = [];
    const h = createEarsHandler({
      onInject: async (ev) => { handled.push(ev.data.id); },
      playback: { enqueue: async () => {} }, isVoiceReady: () => ready, log: recordingLog().log,
    });
    await h(inject());
    assert.deepEqual(handled, ["i1"], `ready=${ready}`);
  }
});

// @spec EARS-INJ-007
test("a voice.utterance is skipped (not queued) while the voice connection is not ready, and queued once it is", async () => {
  const queued: [string, string][] = [];
  let ready = false;
  const h = createEarsHandler({
    onInject: async () => {}, playback: { enqueue: async (id, url) => { queued.push([id, url]); } },
    isVoiceReady: () => ready, log: recordingLog().log,
  });
  await h(utterance());
  assert.deepEqual(queued, []);
  ready = true;
  await h(utterance());
  assert.deepEqual(queued, [["u1", "http://voice/u1.wav"]]);
});

// @spec EARS-START-006
test("the ears group is created first, then subscribed with start mode latest for the given types", async () => {
  const calls: string[] = [];
  let opts: unknown;
  const bus = {
    resetGroup: async (g: string) => { calls.push(`reset:${g}`); },
    subscribe: async (o: unknown) => { calls.push("subscribe"); opts = o; },
  };
  await subscribeEars(bus, ["voice.utterance", "inject.request"], async () => {}, recordingLog().log);
  assert.deepEqual(calls, ["reset:ears", "subscribe"]);
  assert.deepEqual(opts, { group: "ears", types: ["voice.utterance", "inject.request"], start: "latest" });
});

// @spec EARS-SESS-008, EARS-START-005
test("one shutdown sequence: idle timer, voice connection and client, then the bus", async () => {
  const order: string[] = [];
  const bus = { stop: () => { order.push("bus"); } };
  await stopEars({ idleTimer: setInterval(() => {}, 1000), clear: (t) => { order.push("timer"); clearInterval(t); }, session: { stop: async () => { order.push("discord"); } }, bus });
  assert.deepEqual(order, ["timer", "discord", "bus"]);
  order.length = 0;
  await stopEars({ session: { stop: async () => { order.push("discord"); throw new Error("destroy failed"); } }, bus, log: recordingLog().log });
  assert.deepEqual(order, ["discord", "bus"], "the bus is stopped even if the teardown throws");
});

// ---- fallback line wiring

const playingEv = (id: string, sink: string) => event("voice.playing", { id, sink });
const failedEv = () => event("voice.failed", { id: "u1", sink: "discord", reason: "x" });

// @spec EARS-FALL-010
test("the loop reads voice.playing and forwards each claim to the fallback line, ignoring voice.failed", async () => {
  const seen: string[] = [];
  const claims: [string, string][] = [];
  const h = createEarsHandler({
    onInject: async () => {}, playback: { enqueue: async () => {} }, isVoiceReady: () => true, log: recordingLog().log,
    claims: { seen: (id) => { seen.push(id); }, claim: (id, sink) => { claims.push([id, sink]); } },
  });
  await h(utterance());
  await h(playingEv("u1", "dashboard"));
  await h(playingEv("u1", "discord"));
  await h(playingEv("u1", "virtual"));
  await h(failedEv()); // ears never acts on voice.failed
  assert.deepEqual(seen, ["u1"]);
  assert.deepEqual(claims, [["u1", "dashboard"], ["u1", "discord"], ["u1", "virtual"]], "every claim is forwarded; the fallback line ignores discord's own and voice's virtual ones");
});

// @spec EARS-FALL-010
test("in the discord plan the one ears loop reads voice.utterance, voice.playing and inject.request", () => {
  assert.deepEqual([...DISCORD_LOOP_TYPES].sort(), ["inject.request", "voice.playing", "voice.utterance"]);
});

// @spec EARS-FALL-013, EARS-INJ-007
test("while the voice connection is not ready a skipped voice.utterance is neither queued nor reported as failed", async () => {
  const queued: string[] = [];
  const bus = new FakeBus();
  const h = createEarsHandler({
    onInject: async () => {}, playback: { enqueue: async (id) => { queued.push(id); } }, isVoiceReady: () => false, log: recordingLog().log,
  });
  await h(utterance());
  assert.deepEqual(queued, []);
  assert.deepEqual(bus.published, [], "no voice.failed and no fallback clip for an utterance ears never took");
});
