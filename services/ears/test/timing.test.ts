import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConnectorFakeBus, FakeBus, event, recordingLog, silentLog, testConfig, waitFor } from "@cohost/testing";
import { runService, wavWrap, type Heartbeat } from "@cohost/shared";
import type { Frame } from "@cohost/bus";
import { createServer } from "node:net";
import { createEarsService } from "../src/service.js";
import { createInjectHandler } from "../src/inject.js";

/** The real ears service on a fake bus, stub STT, no signals and no exit. */
async function boot(ears: Record<string, unknown>, setup?: (bus: ConnectorFakeBus) => void) {
  const bus = Object.assign(new ConnectorFakeBus(), {
    resetGroup: async () => {},
    subscribe: () => new Promise<void>(() => {}),
  });
  setup?.(bus);
  const svc = createEarsService({ registryIntervalMs: 20, refreshMs: 20 });
  let shutdown: (() => void | Promise<void>) | undefined;
  let hb: Heartbeat | undefined;
  await runService({
    service: "ears", health: svc.health,
    main: async (ctx) => { hb = ctx.heartbeat; await svc.main(ctx); },
    loadConfig: () => testConfig({ ears }),
    createBus: () => bus as never,
    onShutdown: (fn) => { shutdown = fn; },
    exit: () => {}, log: recordingLog().log,
  });
  return { bus, stop: async () => { await shutdown?.(); await hb?.stop(); } };
}

async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((res) => srv.listen(0, "127.0.0.1", res));
  const port = (srv.address() as { port: number }).port;
  await new Promise((res) => srv.close(res));
  return port;
}
const frame = (seq: number): Frame => ({ epoch: 1, seq, rate: 16000, ch: 1, pcm: Buffer.alloc(640, 1), spk: "u1", name: "Chris" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const connectorOffer = [{ cap: "audio-in" as const, tag: "discord", format: { rate: 16000, channels: 1 }, ready: true, transport: "stream" as const }];

// @spec EARS-HEAR-012
test("connector utterance: audioEndedAt is the last frame's arrival, not the later gap-timer close", async () => {
  const r = await boot({ sources: ["discord"], stt_engine: "stub", vad: { engine: "gap" }, silence_ms: 300, min_speech_ms: 100 }, (b) => b.register("discord", connectorOffer));
  try {
    await sleep(80);
    const first = Date.now();
    for (let i = 0; i < 20; i++) { r.bus.feed("in", "discord", frame(i)); await sleep(5); }
    const lastFrameAt = Date.now();
    await waitFor(() => r.bus.of("speech.heard").length === 1, "speech.heard");
    const published = Date.now();
    const at = r.bus.of("speech.heard")[0]!.timing?.audioEndedAt;
    assert.ok(at !== undefined, "timing.audioEndedAt present");
    assert.ok(at >= first && at <= lastFrameAt + 5, `audioEndedAt ${at - first} ms after the first frame, last frame at ${lastFrameAt - first}`);
    assert.ok(published - at >= 250, "the close came silence_ms after the stamped audio end");
  } finally { await r.stop(); }
});

// @spec EARS-HEAR-012
test("dir clip: audioEndedAt is when ears received the clip", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ears-timing-"));
  const r = await boot({ sources: ["dir"], stt_engine: "stub", dir: { path: dir, poll_ms: 20 } });
  try {
    const before = Date.now();
    await writeFile(join(dir, "a.wav"), wavWrap(Buffer.alloc(32000), 16000, 1));
    await waitFor(() => r.bus.of("speech.heard").length === 1, "speech.heard");
    const after = Date.now();
    const at = r.bus.of("speech.heard")[0]!.timing?.audioEndedAt;
    assert.ok(at !== undefined && at >= before && at <= after, `audioEndedAt ${String(at)} within [${before}, ${after}]`);
  } finally { await r.stop(); await rm(dir, { recursive: true, force: true }); }
});

// @spec EARS-HEAR-012
test("injected audio: audioEndedAt is when ears received the request", async () => {
  const bus = new FakeBus();
  const UP = "0123456789abcdef0123456789abcdef";
  bus.takeUpload = async () => wavWrap(Buffer.alloc(32000), 16000, 1);
  const handle = createInjectHandler({ bus, log: silentLog, transcribe: async () => "hello there" });
  const before = Date.now();
  handle(event("inject.request", { id: "a1", target: "ears", kind: "audio", uploadId: UP, contentType: "audio/wav", remember: false }) as never);
  await handle.drain();
  const after = Date.now();
  const at = bus.of("speech.heard")[0]!.timing?.audioEndedAt;
  assert.ok(at !== undefined && at >= before && at <= after, `audioEndedAt ${String(at)} within [${before}, ${after}]`);
});

// @spec EARS-HEAR-012
test("http clip: audioEndedAt is when ears received the clip", async () => {
  const port = await freePort();
  const r = await boot({ sources: ["http"], stt_engine: "stub", http: { host: "127.0.0.1", port } });
  try {
    const post = () => fetch(`http://127.0.0.1:${port}/audio`, { method: "POST", body: wavWrap(Buffer.alloc(32000), 16000, 1), headers: { "content-type": "audio/wav" } });
    let before = Date.now();
    let res: Response | undefined;
    for (let i = 0; i < 50 && !res; i++) { before = Date.now(); res = await post().catch(() => undefined); if (!res) await sleep(20); }
    assert.equal(res?.status, 200);
    const after = Date.now();
    const at = r.bus.of("speech.heard")[0]!.timing?.audioEndedAt;
    assert.ok(at !== undefined && at >= before && at <= after, `audioEndedAt ${String(at)} within [${before}, ${after}]`);
  } finally { await r.stop(); }
});
