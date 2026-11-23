import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import net, { type AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeBus, event, recordingLog, testConfig, waitFor } from "@cohost/testing";
import { runVoice, type VoiceBoot, type VoiceBus } from "../src/boot.js";
import { fakeServer, pcm, streamedHeader, type FakeServer } from "./tts-helpers.js";

type SubscribeCall = { opts: Record<string, unknown>; handler: (ev: never) => unknown };

class BootBus extends FakeBus {
  subscribed: SubscribeCall[] = [];
  async resetGroup(): Promise<void> {}
  subscribe = (async (opts: SubscribeCall["opts"], handler: SubscribeCall["handler"]) => {
    this.subscribed.push({ opts, handler });
    await new Promise(() => {});
  }) as unknown as VoiceBus["subscribe"];
  async stop(): Promise<void> {}
}

const freePort = async () => {
  const probe = net.createServer();
  await new Promise<void>((r) => probe.listen(0, r));
  const port = (probe.address() as AddressInfo).port;
  await new Promise((r) => probe.close(r));
  return port;
};

/** A run of the service with the given `voice` config; shutdown steps run when the test ends. */
function boot(ctx: TestContext, voice: Record<string, unknown>, port: number) {
  const bus = new BootBus();
  const rec = recordingLog();
  const exits: number[] = [];
  const shutdown: (() => void | Promise<void>)[] = [];
  const clipDir = mkdtempSync(join(tmpdir(), "voice-boot-engine-"));
  const b: VoiceBoot = {
    log: rec.log,
    loadConfig: () => testConfig({ voice }),
    createBus: () => bus,
    port, publicUrl: "http://voice:8700", clipDir,
    onShutdown: (fn) => { shutdown.push(fn); },
    exit: (code) => { exits.push(code); },
  };
  ctx.after(async () => { for (const fn of shutdown) await fn(); rmSync(clipDir, { recursive: true, force: true }); });
  return { b, bus, rec, exits };
}

const last = (bus: FakeBus) => bus.health.at(-1)!;
const warned = (rec: ReturnType<typeof recordingLog>) => rec.lines.filter((l) => l.level === "warn").map((l) => JSON.stringify(l.obj) + String(l.msg));
const healthyPocket = (): Promise<FakeServer> => fakeServer((req, res) => { res.writeHead(200); if (req.url === "/health") res.end('{"status":"healthy"}'); else { res.write(streamedHeader()); res.end(pcm(100)); } });

// @spec VOICE-EGR-001
test("an engine whose server is off the LAN logs one warning at start naming the engine and the host; a LAN server logs none", async (ctx) => {
  const off = boot(ctx, { engine: "openai", voice: "nova", openai: { base_url: "https://speech.example.com/v1", model: "tts-1" } }, await freePort());
  void runVoice(off.b);
  await waitFor(() => off.bus.subscribed.length === 1, "subscription");
  const egress = warned(off.rec).filter((w) => w.includes("openai") && w.includes("speech.example.com"));
  assert.equal(egress.length, 1, `one egress warning: ${warned(off.rec).join(" | ")}`);

  const lan = boot(ctx, { engine: "openai", voice: "nova", openai: { base_url: "http://192.168.1.20:8880/v1", model: "tts-1" } }, await freePort());
  void runVoice(lan.b);
  await waitFor(() => lan.bus.subscribed.length === 1, "subscription");
  assert.deepEqual(warned(lan.rec).filter((w) => w.includes("192.168.1.20")), []);
});

// @spec VOICE-EGR-002, VOICE-HLTH-009
test("the heartbeat detail names the engine and the host it talks to, and tts is ok from start for an engine without a probe", async (ctx) => {
  const t = boot(ctx, { engine: "openai", voice: "nova", openai: { base_url: "https://speech.example.com/v1", model: "tts-1" } }, await freePort());
  void runVoice(t.b);
  await waitFor(() => t.bus.health.some((h) => h.state === "ready"), "ready");
  const hb = t.bus.health.find((h) => h.state === "ready")!;
  assert.deepEqual(hb.deps, { tts: "ok" });
  assert.match(String(hb.detail), /openai/);
  assert.match(String(hb.detail), /speech\.example\.com/);
});

// @spec VOICE-HLTH-007, VOICE-HLTH-008, VOICE-HLTH-001
test("pocket starts with tts down, probes GET /health at start, and tts is ok once the probe succeeds", async (ctx) => {
  const s = await healthyPocket();
  ctx.after(() => s.close());
  const t = boot(ctx, { engine: "pocket", pocket: { url: s.url } }, await freePort());
  void runVoice(t.b);
  await waitFor(() => t.bus.subscribed.length === 1, "subscription");
  await waitFor(() => s.requests.some((r) => r.method === "GET" && r.url === "/health"), "the start-up probe", 3000);
  assert.ok(t.bus.health.length > 0 && t.bus.health[0]!.state === "starting");
  await waitFor(() => last(t.bus).deps.tts === "ok", "tts ok after the probe", 4000);
  assert.match(String(last(t.bus).detail ?? ""), /pocket/);
  assert.match(String(last(t.bus).detail ?? ""), /127\.0\.0\.1/);
});

// @spec VOICE-HLTH-007, VOICE-HLTH-010
test("a pocket server that is not up keeps tts down while voice still becomes ready and subscribes", async (ctx) => {
  const port = await freePort(); // nothing listens there
  const t = boot(ctx, { engine: "pocket", pocket: { url: `http://127.0.0.1:${await freePort()}` } }, port);
  void runVoice(t.b);
  await waitFor(() => t.bus.subscribed.length === 1, "subscription: ready is not held back by a down tts");
  await waitFor(() => t.bus.health.length >= 2, "a heartbeat after starting");
  assert.notEqual(last(t.bus).state, "starting");
  assert.deepEqual(last(t.bus).deps, { tts: "down" });
  assert.equal(last(t.bus).state, "degraded");
  assert.match(String(last(t.bus).detail), /pocket/, "the engine is named while tts is down");
  assert.match(String(last(t.bus).detail), /127\.0\.0\.1/, "and the host it talks to");
  assert.deepEqual(t.exits, []);
});

// @spec VOICE-GAP-001, VOICE-GAP-002, VOICE-GAP-003, VOICE-GAP-004, VOICE-GAP-005
test("an incomplete engine configuration starts voice, reports tts down with the reason, still reaches readiness, and fails each line on the tts failed path", async (ctx) => {
  const cases: [Record<string, unknown>, string][] = [
    [{ engine: "openai", voice: "nova", openai: { base_url: "", model: "m" } }, "voice.openai.base_url is not set"],
    [{ engine: "openai", voice: "nova", openai: { base_url: "https://x.example.com/v1", model: "" } }, "voice.openai.model is not set"],
    [{ engine: "openai", voice: "", openai: { base_url: "https://x.example.com/v1", model: "m" } }, "voice.voice is not set"],
    [{ engine: "pocket", pocket: { url: "" } }, "voice.pocket.url is not set"],
  ];
  for (const [voice, reason] of cases) {
    const t = boot(ctx, voice, await freePort());
    void runVoice(t.b);
    await waitFor(() => t.bus.subscribed.length === 1, `subscription (${reason})`);
    await waitFor(() => t.bus.health.length >= 2, "a heartbeat after starting");
    const hb = last(t.bus);
    assert.deepEqual(hb.deps, { tts: "down" }, reason);
    assert.equal(hb.state, "degraded", `${reason}: readiness reached, published degraded`);
    assert.match(String(hb.detail), new RegExp(String(voice.engine)), `${reason}: names the engine while down`);
    assert.match(String(hb.detail), new RegExp(reason.replace(/\./g, "\\.")), `${reason}: in the heartbeat detail`);
    assert.deepEqual(t.exits, [], "voice started");

    await t.bus.subscribed[0]!.handler(event("brain.say", { id: "u1", text: "hello", emotion: "happy", gesture: "wave" }) as never);
    await waitFor(() => t.bus.of("voice.done").length === 1, "the line fails at once", 3000);
    assert.deepEqual(t.bus.of("voice.done"), [{ id: "u1", seq: 0, sink: "error" }], reason);
    assert.deepEqual(t.bus.of("voice.utterance"), []);
    assert.ok(t.rec.msgs("error").includes("tts failed"), reason);
  }
});
