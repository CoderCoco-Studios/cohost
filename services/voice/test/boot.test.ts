import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wavWrap } from "@cohost/shared";
import { FakeBus, recordingLog, testConfig, waitFor } from "@cohost/testing";
import { runVoice, type VoiceBus, type VoiceBoot } from "../src/boot.js";

type SubscribeCall = { opts: Record<string, unknown>; handler: (ev: never) => unknown };

/** A FakeBus plus the two group calls boot makes; each can be held open or made to fail. */
class BootBus extends FakeBus {
  calls: string[] = [];
  subscribed: SubscribeCall[] = [];
  stopped = false;
  resetGate?: Promise<void>;
  resetError?: Error;
  subscribeError?: Error;
  async resetGroup(group: string): Promise<void> {
    this.calls.push(`resetGroup:${group}`);
    await this.resetGate;
    if (this.resetError) throw this.resetError;
  }
  subscribe = (async (opts: SubscribeCall["opts"], handler: SubscribeCall["handler"]) => {
    this.calls.push("subscribe");
    this.subscribed.push({ opts, handler });
    if (this.subscribeError) throw this.subscribeError;
    await new Promise(() => {}); // like the real loop: runs until stop()
  }) as unknown as VoiceBus["subscribe"];
  async stop(): Promise<void> { this.stopped = true; }
}

/** Builds a run; its shutdown steps run when the test ends, pass or fail, so no listener or timer outlives it. */
function boot(ctx: TestContext, over: { bus?: BootBus; engine?: "kokoro" | "stub"; port?: number; lines?: string[]; clipDir?: string } = {}) {
  const bus = over.bus ?? new BootBus();
  const rec = recordingLog();
  const exits: number[] = [];
  const shutdown: (() => void | Promise<void>)[] = [];
  const b: VoiceBoot = {
    log: rec.log,
    loadConfig: () => testConfig({ voice: { engine: over.engine ?? "stub", fallback: { lines: over.lines ?? [] } } }),
    createBus: () => bus,
    port: over.port ?? 0, publicUrl: "http://voice:8700", clipDir: over.clipDir,
    onShutdown: (fn) => { shutdown.push(fn); },
    exit: (code) => { exits.push(code); },
  };
  let closed: Promise<void> | undefined;
  const close = () => (closed ??= (async () => { for (const fn of shutdown) await fn(); })());
  ctx.after(close);
  return { b, bus, rec, exits, shutdown, close };
}

const states = (bus: FakeBus) => bus.health.map((h) => h.state);

// @spec VOICE-SYN-001, VOICE-SINK-010
test("subscribes in group voice with start mode latest to brain.say, voice.playing, voice.failed and voice.stop, and handles them one at a time", async (ctx) => {
  const t = boot(ctx);
  void runVoice(t.b);
  await waitFor(() => t.bus.subscribed.length === 1, "subscription");
  assert.deepEqual(t.bus.calls, ["resetGroup:voice", "subscribe"]); // the group is at the newest entry before the loop reads
  const { opts } = t.bus.subscribed[0]!;
  assert.equal(opts.group, "voice");
  assert.equal(opts.start, "latest");
  assert.deepEqual(opts.types, ["brain.say", "voice.playing", "voice.failed", "voice.stop"]);
  assert.equal("fromNow" in opts, false);
  await t.close();
});

// @spec VOICE-HLTH-001, VOICE-HTTP-005
test("ready only once the HTTP server listens and the consumer group is positioned", async (ctx) => {
  const bus = new BootBus();
  let release!: () => void;
  bus.resetGate = new Promise<void>((r) => { release = r; });
  const t = boot(ctx, { bus });
  void runVoice(t.b);
  await waitFor(() => bus.calls.includes("resetGroup:voice"), "group positioning started");
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(states(bus), ["starting"]); // listening, but the group does not exist yet
  assert.equal(bus.subscribed.length, 0);
  release();
  await waitFor(() => states(bus).includes("ready"), "ready");
  assert.deepEqual(states(bus), ["starting", "ready"]);
  assert.equal(bus.health[1]!.service, "voice");
  assert.equal(bus.health[1]!.mode, "mock"); // engine stub
  await t.close();
});

// @spec VOICE-HTTP-005
test("listens on the configured port and answers /health", async (ctx) => {
  const probe = net.createServer();
  await new Promise<void>((r) => probe.listen(0, r));
  const port = (probe.address() as AddressInfo).port;
  await new Promise((r) => probe.close(r));
  const t = boot(ctx, { port });
  void runVoice(t.b);
  await waitFor(() => t.bus.subscribed.length === 1, "subscription");
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/health`)).text(), "ok");
  await t.close();
});

// @spec VOICE-SYN-006
test("a rejecting subscription logs fatal and exits 1", async (ctx) => {
  const bus = new BootBus();
  bus.subscribeError = new Error("NOGROUP consumer group deleted");
  const t = boot(ctx, { bus });
  await runVoice(t.b);
  assert.deepEqual(t.exits, [1]);
  assert.ok(t.rec.msgs("error").includes("fatal"));
  await t.close();
});

// @spec VOICE-SYN-006
test("a startup failure (config load, group positioning) exits 1; past config it logs fatal", async (ctx) => {
  const bad = boot(ctx);
  bad.b.loadConfig = () => { throw new Error("config invalid"); };
  await runVoice(bad.b);
  assert.deepEqual(bad.exits, [1]);
  assert.ok(bad.rec.msgs("error").includes("config invalid")); // the shared bootstrap logs the loader's message
  assert.deepEqual(bad.bus.health, []); // no heartbeat before a configuration exists

  const bus = new BootBus();
  bus.resetError = new Error("redis down");
  const t = boot(ctx, { bus });
  await runVoice(t.b);
  assert.deepEqual(t.exits, [1]);
  assert.deepEqual(states(bus), ["starting"]); // never reported ready
  await t.close();
});

// @spec VOICE-HLTH-004
test("shutdown closes the HTTP server and stops the bus", async (ctx) => {
  const t = boot(ctx);
  void runVoice(t.b);
  await waitFor(() => t.bus.subscribed.length === 1, "subscription");
  await t.close();
  assert.equal(t.bus.stopped, true);
});

// @spec VOICE-STUB-003
test("the stub engine logs a startup warning that utterances are silent", async (ctx) => {
  const t = boot(ctx, { engine: "stub" });
  void runVoice(t.b);
  await waitFor(() => t.bus.subscribed.length === 1, "subscription");
  assert.ok(t.rec.msgs("warn").some((m) => /stub/.test(String(m))));
  await t.close();
});

const freePort = async () => {
  const probe = net.createServer();
  await new Promise<void>((r) => probe.listen(0, r));
  const port = (probe.address() as AddressInfo).port;
  await new Promise((r) => probe.close(r));
  return port;
};

// @spec VOICE-CLIP-008
test("the stub engine never touches the clip store and answers 404 on the fallback routes", async (ctx) => {
  const root = mkdtempSync(join(tmpdir(), "voice-boot-"));
  const clipDir = join(root, "voice", "fallback-clips");
  const port = await freePort();
  const t = boot(ctx, { engine: "stub", lines: ["Should never be spoken."], clipDir, port });
  try {
    void runVoice(t.b);
    await waitFor(() => t.bus.subscribed.length === 1, "subscription");
    assert.equal((await fetch(`http://127.0.0.1:${port}/fallback/manifest.json`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/fallback/00-12345678.wav`)).status, 404);
    assert.equal(existsSync(root + "/voice"), false, "nothing created under the data directory");
  } finally {
    await t.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// @spec VOICE-CLIP-003
test("with the kokoro engine, clip generation starts after ready and does not hold up the bus loop", async (ctx) => {
  const root = mkdtempSync(join(tmpdir(), "voice-boot-"));
  const clipDir = join(root, "fallback-clips");
  const requests: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const tts = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", async () => {
      requests.push((JSON.parse(body) as { input: string }).input);
      await gate;
      res.writeHead(200, { "content-type": "audio/wav" });
      res.end(wavWrap(Buffer.alloc(24000 * 2 * 0.3), 24000, 1));
    });
  });
  await new Promise<void>((r) => tts.listen(0, "127.0.0.1", r));
  const savedTts = process.env.TTS_URL;
  process.env.TTS_URL = `http://127.0.0.1:${(tts.address() as AddressInfo).port}`;
  const port = await freePort();
  const t = boot(ctx, { engine: "kokoro", lines: ["Error: unable to play line."], clipDir, port });
  try {
    void runVoice(t.b);
    await waitFor(() => states(t.bus).includes("ready") && t.bus.subscribed.length === 1, "ready and subscribed");
    await waitFor(() => requests.length === 1, "first clip request");
    assert.deepEqual(requests, ["Error: unable to play line."]);
    assert.equal((await fetch(`http://127.0.0.1:${port}/fallback/manifest.json`)).status, 404, "nothing committed while TTS is busy");
    release();
    // The file lands on disk (rename on the libuv pool) a turn before the service adopts it and the route serves it:
    // wait for the commit itself, not for the file.
    await waitFor(() => t.rec.msgs("info").includes("fallback clips committed"), "manifest committed");
    assert.ok(existsSync(join(clipDir, "manifest.json")));
    const m = await (await fetch(`http://127.0.0.1:${port}/fallback/manifest.json`)).json() as { clips: { name: string }[] };
    assert.equal(m.clips.length, 1);
    assert.equal((await fetch(`http://127.0.0.1:${port}/fallback/${m.clips[0]!.name}`)).status, 200);
  } finally {
    release();
    await t.close();
    await new Promise((r) => tts.close(r));
    if (savedTts === undefined) delete process.env.TTS_URL; else process.env.TTS_URL = savedTts;
    rmSync(root, { recursive: true, force: true });
  }
});
