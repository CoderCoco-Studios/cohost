import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeBus, event, recordingLog, testConfig, waitFor } from "@cohost/testing";
import { runService, wavWrap } from "@cohost/shared";
import type { BusEvent } from "@cohost/bus";
import { createMouth, type MouthBus } from "../src/mouth.js";

type Outputs = Record<string, Record<string, unknown>>;

/** The whole service run by `runService` against a fake bus, a faked Discord module and a faked clip refresh. */
function rig(outputs: Outputs, over: { token?: string; loginError?: Error } = {}) {
  const calls: string[] = [];
  const subs: { opts: Record<string, unknown>; handler: (ev: BusEvent) => Promise<void> }[] = [];
  const bus = Object.assign(new FakeBus(), {
    resetGroup: async (g: string) => { calls.push(`reset:${g}`); },
    subscribe: (opts: Record<string, unknown>, handler: (ev: BusEvent) => Promise<void>) => { calls.push("subscribe"); subs.push({ opts, handler }); return new Promise<void>(() => {}); },
    stop: () => { calls.push("bus.stop"); },
  });
  const rec = recordingLog();
  const exits: number[] = [];
  let shutdown: (() => void | Promise<void>) | undefined;
  const discordOutputs: string[] = [];
  const queued: string[] = [];
  const mouth = createMouth({
    token: over.token ?? "tok",
    idleWarnEveryMs: 10,
    fetchAudio: async () => wavWrap(Buffer.alloc(24 * 30 * 2), 24000, 1),
    clipSync: (() => { calls.push("clips.start"); return { first: Promise.resolve(), stop: () => { calls.push("clips.stop"); } }; }) as never,
    loadDiscord: async () => { calls.push("discord.load"); return {
      createDiscordOutput: (d: { cfg: { mouth: { outputs: { discord: { enabled: boolean } } } } }) => {
        discordOutputs.push(String(d.cfg.mouth.outputs.discord.enabled));
        return {
          output: { name: "discord", isReady: () => true, playback: { enqueue: async (id: string) => { queued.push(id); } }, close() { calls.push("discord.close"); } },
          session: {
            start: async () => { calls.push("discord.start"); if (over.loginError) throw over.loginError; },
            stop: async () => { calls.push("discord.stop"); },
          },
        };
      },
    } as never; },
  });
  const done = runService<MouthBus>({
    service: "mouth", health: mouth.health, main: mouth.main,
    loadConfig: () => testConfig({ mouth: { outputs } }),
    createBus: () => bus as never,
    onShutdown: (fn) => { shutdown = fn; },
    exit: (code) => { exits.push(code); },
    log: rec.log,
  });
  const lastHealth = () => bus.health.at(-1)!;
  return { bus, calls, subs, rec, exits, done, queued, discordOutputs, lastHealth, stop: async () => { await shutdown?.(); } };
}

const utterance = (id: string) => event("voice.utterance", { id, text: "hi", emotion: "neutral", durationMs: 30, envelopeHz: 50, envelope: [0], audioUrl: `http://voice/${id}.wav`, sampleRate: 24000 });

// @spec MOUTH-START-001, MOUTH-START-004, MOUTH-START-006
test("mouth with no output enabled stays up idle: no client, no subscription, no clips, mode off and ready; shutdown stops the bus", async () => {
  const r = rig({ discord: { enabled: false }, dryrun: { enabled: false } });
  try {
    await r.done;
    assert.deepEqual(r.calls, []);
    assert.deepEqual(r.exits, []);
    assert.equal(r.bus.published.length, 0);
    await waitFor(() => r.bus.health.some((h) => h.state === "ready"), "ready heartbeat");
    assert.equal(r.lastHealth().mode, "off");
  } finally {
    await r.stop();
  }
  assert.deepEqual(r.calls, ["bus.stop"]);
});

// @spec MOUTH-START-002, MOUTH-START-004
test("discord enabled without a token idles degraded with the error now and the reminder repeating, until shutdown clears it", async () => {
  const r = rig({ discord: { enabled: true }, dryrun: { enabled: false } }, { token: "" });
  try {
    await r.done;
    assert.deepEqual(r.calls, [], "no client, no subscription, no clips");
    assert.equal(r.rec.msgs("error").length, 1);
    await waitFor(() => r.rec.msgs("warn").length >= 2, "two reminders");
    assert.ok(r.rec.msgs("warn").every((m) => m === "DISCORD_TOKEN is not set; still idle"));
    await waitFor(() => r.bus.health.some((h) => h.state === "degraded"), "degraded heartbeat");
    const hb = r.bus.health.find((h) => h.state === "degraded")!;
    assert.equal(hb.detail, "DISCORD_TOKEN is not set");
    assert.equal(hb.mode, "live");
    assert.equal(hb.deps.discord, "down");
  } finally {
    await r.stop();
  }
  const n = r.rec.msgs("warn").length;
  await new Promise((res) => setTimeout(res, 40));
  assert.equal(r.rec.msgs("warn").length, n, "the reminder timer is cleared");
  assert.deepEqual(r.calls, ["bus.stop"]);
});

// @spec MOUTH-DRY-001, MOUTH-DRY-004, MOUTH-DRY-005, MOUTH-START-003, MOUTH-START-005
test("the local plan runs the dryrun output with no Discord: group mouth at latest, clip refresh, mode mock, and a line is played and released", async () => {
  const r = rig({ discord: { enabled: false }, dryrun: { enabled: true } }, { token: "" });
  try {
    await r.done;
    assert.deepEqual(r.calls, ["reset:mouth", "subscribe", "clips.start"], "no Discord module loaded, subscription before the clip refresh");
    assert.deepEqual(r.subs[0]!.opts, { group: "mouth", types: ["voice.utterance", "voice.playing"], start: "latest" });
    await waitFor(() => r.bus.health.some((h) => h.state === "ready"), "ready heartbeat");
    assert.equal(r.lastHealth().mode, "mock");
    assert.equal(r.lastHealth().deps.dryrun, "ok");
    await r.subs[0]!.handler(utterance("u1"));
    await waitFor(() => r.bus.of("voice.done").length === 1, "voice.done");
    assert.deepEqual(r.bus.of("voice.playing"), [{ id: "u1", sink: "dryrun" }]);
    assert.deepEqual(r.bus.of("voice.done"), [{ id: "u1", sink: "dryrun" }]);
  } finally {
    await r.stop();
  }
  assert.deepEqual(r.calls.slice(3), ["clips.stop", "bus.stop"], "shutdown stops the clip refresh and then the bus");
  assert.deepEqual(r.exits, []);
});

// @spec MOUTH-START-003, MOUTH-START-002, MOUTH-DRY-001
test("dryrun with a Discord output that has no token: no client, the dryrun output runs, reported degraded with the reminder", async () => {
  const r = rig({ discord: { enabled: true }, dryrun: { enabled: true } }, { token: "" });
  try {
    await r.done;
    assert.ok(!r.calls.includes("discord.load"));
    assert.equal(r.rec.msgs("error").length, 1);
    await waitFor(() => r.rec.msgs("warn").length >= 1, "a reminder");
    await waitFor(() => r.bus.health.some((h) => h.state === "degraded"), "degraded heartbeat");
    const hb = r.bus.health.findLast((h) => h.state === "degraded")!;
    assert.equal(hb.detail, "DISCORD_TOKEN is not set");
    assert.deepEqual(hb.deps, { discord: "down", dryrun: "ok" });
    assert.equal(hb.mode, "live");
    await r.subs[0]!.handler(utterance("u1"));
    await waitFor(() => r.bus.of("voice.done").length === 1, "dryrun played it");
  } finally {
    await r.stop();
  }
});

// @spec MOUTH-START-006, MOUTH-SESS-007, MOUTH-PLAY-001, MOUTH-DRY-001
test("the discord plan loads Discord, subscribes before the login, feeds every output, and shuts down clips, then Discord, then the bus", async () => {
  const r = rig({ discord: { enabled: true }, dryrun: { enabled: true } });
  try {
    await r.done;
    assert.deepEqual(r.calls, ["discord.load", "reset:mouth", "subscribe", "clips.start", "discord.start"]);
    await r.subs[0]!.handler(utterance("u1"));
    assert.deepEqual(r.queued, ["u1"], "the Discord output got the line");
    await waitFor(() => r.bus.of("voice.done").length === 1, "the dryrun output got it too");
  } finally {
    await r.stop();
  }
  const shutdown = r.calls.slice(5);
  assert.ok(shutdown.indexOf("clips.stop") < shutdown.indexOf("discord.stop"), shutdown.join());
  assert.equal(shutdown.at(-1), "bus.stop");
  assert.deepEqual(r.exits, []);
});

// @spec MOUTH-SESS-001, MOUTH-START-006
test("a failed Discord login logs fatal and ends the process with code 1 through runService", async () => {
  const r = rig({ discord: { enabled: true }, dryrun: { enabled: false } }, { loginError: new Error("An invalid token was provided") });
  try {
    await r.done;
    assert.deepEqual(r.exits, [1]);
    assert.ok(r.rec.msgs("error").includes("discord login failed"));
    assert.ok(r.rec.msgs("error").includes("fatal"));
  } finally {
    await r.stop();
  }
});

// @spec MOUTH-START-006
test("discord.js is loaded only in the discord plan", async () => {
  const r = rig({ discord: { enabled: true }, dryrun: { enabled: false } }, { token: "" });
  try {
    await r.done;
    assert.ok(!r.calls.includes("discord.load"));
  } finally {
    await r.stop();
  }
});
