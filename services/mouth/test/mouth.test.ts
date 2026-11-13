import { test } from "node:test";
import assert from "node:assert/strict"; import { mkdtempSync, readdirSync, rmSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { ConnectorFakeBus, event, recordingLog, testConfig, waitFor } from "@cohost/testing";
import { runService, wavWrap } from "@cohost/shared";
import type { BusEvent } from "@cohost/bus";
import { createMouth, type MouthBus, type MouthOptions } from "../src/mouth.js";

type Outputs = Record<string, Record<string, unknown>>;
const SINK = [{ cap: "audio-out" as const, tag: "discord", format: { rate: 48000, channels: 2 }, ready: true, transport: "stream" as const }];

/** The whole service run by `runService` against a fake bus with a connector registry and a faked clip refresh. */
function rig(outputs: Outputs, over: { connector?: boolean; opts?: Partial<MouthOptions> } = {}) {
  const calls: string[] = [];
  const subs: { opts: Record<string, unknown>; handler: (ev: BusEvent) => Promise<void> }[] = [];
  const bus = Object.assign(new ConnectorFakeBus(), {
    resetGroup: async (g: string) => { calls.push(`reset:${g}`); },
    subscribe: (opts: Record<string, unknown>, handler: (ev: BusEvent) => Promise<void>) => { calls.push("subscribe"); subs.push({ opts, handler }); return new Promise<void>(() => {}); },
  });
  const stopBus = bus.stop.bind(bus);
  bus.stop = () => { calls.push("bus.stop"); stopBus(); };
  if (over.connector) bus.register("discord", SINK);
  const rec = recordingLog();
  const exits: number[] = [];
  let shutdown: (() => void | Promise<void>) | undefined;
  const mouth = createMouth({
    registryIntervalMs: 15,
    fetchAudio: async () => wavWrap(Buffer.alloc(24 * 30 * 2), 24000, 1),
    clipSync: (() => { calls.push("clips.start"); return { first: Promise.resolve(), stop: () => { calls.push("clips.stop"); } }; }) as never,
    ...over.opts,
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
  return { bus, calls, subs, rec, exits, done, lastHealth, stop: async () => { await shutdown?.(); } };
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

// @spec MOUTH-DRY-001, MOUTH-DRY-004, MOUTH-DRY-005, MOUTH-START-003, MOUTH-START-005
test("the local plan runs the dryrun output with no Discord: group mouth at latest, clip refresh, mode mock, and a line is played and released", async () => {
  const r = rig({ discord: { enabled: false }, dryrun: { enabled: true } }, {});
  try {
    await r.done;
    assert.deepEqual(r.calls, ["reset:mouth", "subscribe", "clips.start"], "no Discord module loaded, subscription before the clip refresh");
    assert.deepEqual(r.subs[0]!.opts, { group: "mouth", types: ["voice.utterance", "voice.playing", "voice.stop", "control"], start: "latest" });
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

// @spec MOUTH-CONN-001, MOUTH-CONN-003, MOUTH-HLTH-002, MOUTH-START-003, CONN-ISO-001
test("a discord output with no connector: mouth runs and subscribes, deps.discord is down (degraded) and a line is skipped; when the sink registers it plays with no restart", async () => {
  const r = rig({ discord: { enabled: true }, dryrun: { enabled: true } });
  try {
    await r.done;
    assert.deepEqual(r.calls, ["reset:mouth", "subscribe", "clips.start"]);
    await waitFor(() => r.bus.health.some((h) => h.state === "degraded"), "degraded heartbeat");
    const hb = r.bus.health.findLast((h) => h.state === "degraded")!;
    assert.deepEqual(hb.deps, { discord: "down", dryrun: "ok", file: "n/a", http: "n/a" });
    assert.equal(hb.mode, "live");
    await r.subs[0]!.handler(utterance("u1"));
    await waitFor(() => r.bus.of("voice.done").length === 1, "dryrun played it");
    assert.deepEqual(r.bus.of("voice.playing"), [{ id: "u1", sink: "dryrun" }], "discord skipped it, claiming nothing");
    assert.equal(r.bus.frames.length, 0);
    r.bus.register("discord", SINK);
    await waitFor(() => r.lastHealth().deps.discord === "ok" && r.lastHealth().state === "ready", "discord ok and ready");
    await r.subs[0]!.handler(utterance("u2"));
    await waitFor(() => r.bus.of("voice.done").filter((d) => d.sink === "discord").length === 1, "the discord sink played u2");
    assert.ok(r.bus.frames.length > 0 && r.bus.frames.every((f) => f.dir === "out" && f.tag === "discord" && f.frame.utt === "u2"));
  } finally {
    await r.stop();
  }
});

// @spec MOUTH-START-006, MOUTH-PLAY-001, MOUTH-DRY-001, MOUTH-CONN-001, MOUTH-CONN-002
test("the discord plan holds no Discord client, subscribes, feeds every output, and shuts down clips, then the outputs, then the bus", async () => {
  const r = rig({ discord: { enabled: true }, dryrun: { enabled: true } }, { connector: true });
  try {
    await r.done;
    assert.deepEqual(r.calls, ["reset:mouth", "subscribe", "clips.start"]);
    await waitFor(() => r.lastHealth().deps.discord === "ok", "discord ready");
    await r.subs[0]!.handler(utterance("u1"));
    await waitFor(() => r.bus.of("voice.done").length === 2, "both outputs played it");
    assert.deepEqual(r.bus.of("voice.playing").map((p) => p.sink).sort(), ["discord", "dryrun"]);
  } finally {
    await r.stop();
  }
  const shutdown = r.calls.slice(3);
  assert.equal(shutdown[0], "clips.stop");
  assert.equal(shutdown.at(-1), "bus.stop");
  assert.deepEqual(r.exits, []);
});

const setRoutingEv = (routing: unknown) => event("control", { cmd: "set_routing", target: "mouth", routing } as never);

// @spec MOUTH-LIVE-001, MOUTH-LIVE-002, MOUTH-LIVE-006, MOUTH-HLTH-001
test("live routing in the local plan: a set_routing on the one loop switches dryrun off (deps n/a, line skipped), reports the routing as the detail and switches it back on", async () => {
  const r = rig({ discord: { enabled: false }, dryrun: { enabled: true } }, {});
  try {
    await r.done;
    const handle = r.subs[0]!.handler;
    await handle(setRoutingEv({ dryrun: { enabled: false } }));
    await waitFor(() => r.lastHealth().deps.dryrun === "n/a", "dryrun n/a");
    assert.equal(r.lastHealth().detail, 'routing {"dryrun":{"enabled":false}}');
    await handle(utterance("u1"));
    await new Promise((res) => setTimeout(res, 60));
    assert.equal(r.bus.of("voice.playing").length, 0, "switched off: nothing claimed");
    await handle(setRoutingEv({ dryrun: { enabled: true } }));
    await waitFor(() => r.lastHealth().deps.dryrun === "ok", "dryrun ok again");
    await handle(utterance("u2"));
    await waitFor(() => r.bus.of("voice.done").length === 1, "played again");
    assert.deepEqual(r.bus.of("voice.playing"), [{ id: "u2", sink: "dryrun" }]);
  } finally {
    await r.stop();
  }
});

// @spec MOUTH-LIVE-003, MOUTH-LIVE-004, MOUTH-LIVE-006
test("live routing never creates a Discord client: naming discord in the local plan, or an unknown id, is rejected and reported in the detail", async () => {
  const r = rig({ discord: { enabled: false }, dryrun: { enabled: true } }, {});
  try {
    await r.done;
    await r.subs[0]!.handler(setRoutingEv({ discord: { enabled: true } }));
    await waitFor(() => (r.lastHealth().detail ?? "").startsWith("set_routing rejected:"), "rejection detail");
    assert.equal(r.lastHealth().detail, 'set_routing rejected: output "discord" is not running; routing {"dryrun":{"enabled":true}}');
    await r.subs[0]!.handler(setRoutingEv({ discrod: { enabled: true } }));
    await waitFor(() => (r.lastHealth().detail ?? "").includes('unknown output id "discrod"'), "unknown id detail");
    assert.deepEqual(r.bus.frames, [], "no frame was written");
  } finally {
    await r.stop();
  }
});

// @spec MOUTH-LIVE-001, MOUTH-START-001
test("the idle off plan subscribes to nothing, so a set_routing has nothing to reach", async () => {
  const r = rig({ discord: { enabled: false }, dryrun: { enabled: false } });
  try {
    await r.done;
    assert.equal(r.subs.length, 0);
  } finally {
    await r.stop();
  }
});

// @spec MOUTH-FILE-001, MOUTH-HTTP-001, MOUTH-ROUTE-003
test("file and http outputs run in the local plan with no Discord: each line is archived to the data directory and POSTed, and heartbeat mode is live", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mouth-data-"));
  const prev = process.env.COHOST_DATA_DIR;
  process.env.COHOST_DATA_DIR = dataDir;
  const posts: string[] = [];
  const r = rig(
    { discord: { enabled: false }, dryrun: { enabled: false }, file: { enabled: true, dir: "mouth/outputs", max_files: 5 }, http: { enabled: true, url: "http://sink.test/in" } },
    { opts: { httpPost: async (url, init) => { posts.push(`${url}#${init.headers["x-cohost-utterance-id"]}`); return { status: 200 }; } } },
  );
  try {
    await r.done;
    await waitFor(() => r.bus.health.some((h) => h.state === "ready"), "ready heartbeat");
    assert.equal(r.lastHealth().mode, "live");
    assert.deepEqual(r.lastHealth().deps, { discord: "n/a", dryrun: "n/a", file: "ok", http: "ok" });
    await r.subs[0]!.handler(utterance("u1"));
    await waitFor(() => r.bus.of("voice.done").length === 2, "both outputs released the line");
    assert.deepEqual(r.bus.of("voice.playing").map((p) => p.sink).sort(), ["file", "http"]);
    assert.equal(readdirSync(join(dataDir, "mouth", "outputs")).length, 1);
    assert.deepEqual(posts, ["http://sink.test/in#u1"]);
  } finally {
    await r.stop();
    if (prev === undefined) delete process.env.COHOST_DATA_DIR; else process.env.COHOST_DATA_DIR = prev;
    rmSync(dataDir, { recursive: true, force: true });
  }
});

// @spec MOUTH-ROUTE-007
test("an unknown id in a line's route sets the heartbeat detail to the ignored id followed by the routing", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mouth-route-"));
  const prev = process.env.COHOST_DATA_DIR;
  process.env.COHOST_DATA_DIR = dataDir;
  const r = rig({ discord: { enabled: false }, dryrun: { enabled: true } });
  try {
    await r.done;
    await waitFor(() => r.bus.health.some((h) => h.state === "ready"), "ready heartbeat");
    await r.subs[0]!.handler(event("voice.utterance", { id: "x1", text: "hi", emotion: "neutral", route: ["bogus", "dryrun"], durationMs: 30, envelopeHz: 50, envelope: [0], audioUrl: "http://voice/x1.wav", sampleRate: 24000 }));
    await waitFor(() => r.bus.health.some((h) => h.detail?.startsWith('route ignored unknown output id "bogus"; routing {"dryrun":{"enabled":true}}')), "route detail heartbeat");
  } finally {
    await r.stop();
    if (prev === undefined) delete process.env.COHOST_DATA_DIR; else process.env.COHOST_DATA_DIR = prev;
    rmSync(dataDir, { recursive: true, force: true });
  }
});
