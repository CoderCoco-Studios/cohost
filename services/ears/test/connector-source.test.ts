import { test } from "node:test";
import assert from "node:assert/strict";
import { ConnectorRegistry, type Frame } from "@cohost/bus";
import { ConnectorFakeBus, recordingLog, silentLog, waitFor } from "@cohost/testing";
import { createConnectorSource } from "../src/connector-source.js";
import type { Clip } from "../src/capture.js";

const IN = { rate: 16000, channels: 1 };
const offer = (tag: string, over: Record<string, unknown> = {}) => [{ cap: "audio-in" as const, tag, format: IN, ready: true, transport: "stream" as const, ...over }];
const pcmMs = (ms: number, fill = 1) => Buffer.alloc(Math.round((ms / 1000) * 16000) * 2, fill);
let seqNo = 0;
const frame = (spk: string, name: string, ms = 20, over: Partial<Frame> = {}): Frame => ({ epoch: 1, seq: seqNo++, rate: 16000, ch: 1, pcm: pcmMs(ms), spk, name, ...over });

interface Heard { clip: Clip; speaker: string; source?: string; speakerId?: string }

async function rig(opts: { silenceMs?: number; tag?: string; transport?: "stream" | "http"; registered?: boolean; listener?: { ensure(): Promise<void>; bound(): boolean } } = {}) {
  seqNo = 0;
  const tag = opts.tag ?? "discord";
  const bus = new ConnectorFakeBus();
  if (opts.registered !== false) bus.register(tag, offer(tag, { transport: opts.transport ?? "stream" }));
  const registry = new ConnectorRegistry(bus as never, 10);
  await registry.start();
  const heard: Heard[] = [];
  const src = createConnectorSource({
    name: tag, bus: bus as never, registry, log: recordingLog().log, silenceMs: opts.silenceMs ?? 40,
    hear: async (clip, speaker, source, speakerId) => { heard.push({ clip, speaker, source, speakerId }); return { heard: true, text: "x" }; },
    listener: opts.listener,
  });
  await src.start();
  return { bus, registry, src, heard, tag, stop: async () => { await src.stop(); registry.stop(); } };
}

// @spec EARS-HEAR-001, EARS-HEAR-002, EARS-CON-001
test("frames of one speaker are one utterance, closed after silence_ms without a frame, labelled with name and spk", async () => {
  const r = await rig({ silenceMs: 60 });
  try {
    for (let i = 0; i < 5; i++) { r.bus.feed("in", "discord", frame("u1", "Chris")); await new Promise((res) => setTimeout(res, 15)); }
    assert.equal(r.heard.length, 0, "frames kept arriving inside the gap: still open");
    await waitFor(() => r.heard.length === 1, "utterance closed");
    const h = r.heard[0]!;
    assert.deepEqual([h.speaker, h.speakerId, h.source], ["Chris", "u1", "discord"]);
    assert.deepEqual([h.clip.rate, h.clip.channels, h.clip.pcm.length], [16000, 1, 5 * 640], "the collected 16 kHz mono PCM, unconverted");
  } finally { await r.stop(); }
});

// @spec EARS-HEAR-001
test("one open buffer per spk: two speakers are two utterances, and a later gap starts a new one", async () => {
  const r = await rig({ silenceMs: 30 });
  try {
    r.bus.feed("in", "discord", frame("a", "Ann"));
    r.bus.feed("in", "discord", frame("b", "Bob"));
    r.bus.feed("in", "discord", frame("a", "Ann"));
    await waitFor(() => r.heard.length === 2, "both closed");
    assert.deepEqual(r.heard.map((h) => [h.speakerId, h.clip.pcm.length]).sort(), [["a", 1280], ["b", 640]]);
    r.bus.feed("in", "discord", frame("a", "Ann"));
    await waitFor(() => r.heard.length === 3, "new utterance after the gap");
  } finally { await r.stop(); }
});

// @spec CONN-AUD-004, EARS-HEAR-001
test("an empty name falls back to the spk label, and a frame with no spk uses one constant speaker for the source", async () => {
  const r = await rig({ silenceMs: 20 });
  try {
    r.bus.feed("in", "discord", frame("u9", ""));
    r.bus.feed("in", "discord", { epoch: 1, seq: seqNo++, rate: 16000, ch: 1, pcm: pcmMs(20) });
    await waitFor(() => r.heard.length === 2, "both closed");
    assert.deepEqual(r.heard.map((h) => [h.speaker, h.speakerId]).sort(), [["discord", "discord"], ["u9", "u9"]]);
  } finally { await r.stop(); }
});

// @spec EARS-CON-003
test("a frame of the wrong format or malformed is dropped and counted; a seq gap is counted as loss", async () => {
  const r = await rig({ silenceMs: 20 });
  try {
    r.bus.feed("in", "discord", frame("u1", "C", 20, { rate: 48000, ch: 2 }));
    r.bus.feedRaw("in", "discord", ["v", "9"]);
    r.bus.feed("in", "discord", frame("u1", "C"));
    seqNo += 3;
    r.bus.feed("in", "discord", frame("u1", "C"));
    assert.match(r.src.detail(), /lost 3, dropped 2/);
    await waitFor(() => r.heard.length === 1, "the good frames were heard");
    assert.equal(r.heard[0]!.clip.pcm.length, 2 * 640);
  } finally { await r.stop(); }
});

// @spec EARS-CON-004
test("when the connector disappears mid-utterance, the open utterance is closed by the silence rule and heard", async () => {
  const r = await rig({ silenceMs: 40 });
  try {
    r.bus.feed("in", "discord", frame("u1", "Chris", 500));
    r.bus.regs.delete("discord");
    await waitFor(() => r.src.status() === "down", "down once the registry drops it");
    await waitFor(() => r.heard.length === 1, "closed by silence");
    assert.equal(r.heard[0]!.clip.pcm.length, 16000);
  } finally { await r.stop(); }
});

// @spec EARS-CON-005, CONN-ISO-001
test("status follows a live ready registration and the stream read: down with none, ok when it appears, down when not ready, no restart", async () => {
  const r = await rig({ registered: false });
  try {
    assert.equal(r.src.status(), "down");
    assert.match(r.src.detail(), /discord connector not connected/);
    r.bus.register("discord", offer("discord"));
    await waitFor(() => r.src.status() === "ok", "ok after the connector appears");
    assert.doesNotMatch(r.src.detail(), /not connected/);
    r.bus.register("discord", offer("discord", { ready: false }));
    await waitFor(() => r.src.status() === "down", "down while not ready");
    r.bus.register("discord", offer("discord"));
    await waitFor(() => r.src.status() === "ok", "ok again");
  } finally { await r.stop(); }
});

// @spec EARS-CON-001, CONN-DESK-003
test("a registration with transport http: no stream is read, the source is ok only while the listener is bound and the tag ready", async () => {
  let bound = false;
  const ensured: number[] = [];
  const r = await rig({ tag: "desktop", transport: "http", listener: { ensure: async () => { ensured.push(1); bound = true; }, bound: () => bound } });
  try {
    assert.deepEqual(r.bus.tails, [], "no audio.in.desktop read");
    await waitFor(() => r.src.status() === "ok", "listener started on the registration and bound");
    assert.ok(ensured.length >= 1);
    r.bus.regs.delete("desktop");
    await waitFor(() => r.src.status() === "down", "down when the registration lapses");
    r.bus.feed("in", "desktop", frame("x", "x"));
    await new Promise((res) => setTimeout(res, 60));
    assert.equal(r.heard.length, 0);
  } finally { await r.stop(); }
});

// @spec EARS-SRC-004
test("stop closes the source on its own: frames after stop are ignored and nothing is heard", async () => {
  const r = await rig({ silenceMs: 20 });
  r.bus.feed("in", "discord", frame("u1", "C"));
  await r.stop();
  r.bus.feed("in", "discord", frame("u2", "D"));
  await new Promise((res) => setTimeout(res, 60));
  assert.equal(r.heard.filter((h) => h.speakerId === "u2").length, 0);
  assert.ok(silentLog);
});
