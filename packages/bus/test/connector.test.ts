// Connector registry and audio streams on an in-memory fake transport: no server and no Redis commands involved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeTransport } from "../../testing/src/fake-transport.js";
import {
  Bus, ConnectorRegistrar, ConnectorRegistry, FrameSequencer, FrameTracker, watchConnectors, encodeFrame, decodeFrame, parseRegistration, findReady, findOffer,
  tagProblem, AUDIO_MAXLEN, MAX_FRAME_BYTES, type AudioDirection, type EntryFields, type EventStream, type Frame, type Registration, type CapabilityEntry,
} from "../src/index.js";

/** A `FakeTransport` whose registry and audio streams keep state, so the registrar, registry and tails run end to end. */
class MemTransport extends FakeTransport {
  /** Registrations by connector id: the JSON written and the lease. */
  kv = new Map<string, { json: string; leaseMs: number }>();
  writes = 0;
  heartbeats: EntryFields[] = [];
  appended: { dir: AudioDirection; tag: string; frame: Frame }[] = [];
  writeRegistration(id: string, json: string, leaseMs: number) {
    return this.run("writeRegistration", [id, json, leaseMs], () => { this.writes++; this.kv.set(id, { json, leaseMs }); });
  }
  readRegistration(id: string) { return this.run("readRegistration", [id], () => this.kv.get(id)?.json ?? null); }
  deleteRegistration(id: string) { return this.run("deleteRegistration", [id], () => { this.kv.delete(id); }); }
  listRegistrations() { return this.run("listRegistrations", [], () => [...this.kv.values()].map((v) => v.json)); }
  append(stream: EventStream, fields: EntryFields) {
    return this.run("append", [stream, fields], () => { if (stream === "health") this.heartbeats.push(fields); return "1-0"; });
  }
  appendFrame(dir: AudioDirection, tag: string, frame: Frame) {
    return this.run("appendFrame", [dir, tag, frame], () => { this.appended.push({ dir, tag, frame }); return "1-0"; });
  }
}

const busWith = (fake: MemTransport, prefix = "t") => new Bus("t", undefined, "redis://fake", { transport: fake.factory, streamPrefix: prefix, retryBaseMs: 5, retryMaxMs: 20 });
const caps = (ready = true): CapabilityEntry[] => [
  { cap: "audio-in", tag: "discord", format: { rate: 16000, channels: 1 }, ready },
  { cap: "audio-out", tag: "discord", format: { rate: 48000, channels: 2 }, ready },
];
const frame = (over: Partial<Frame> = {}): Frame => ({ epoch: 100, seq: 0, rate: 16000, ch: 1, pcm: Buffer.alloc(640), spk: "u1", name: "Ann", ...over });
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

// @spec CONN-REG-001, CONN-REG-002, BUS-AUD-002
test("a registration is JSON under <prefix>:connector:<id> with a lease of three intervals, not a stream entry", async () => {
  const fake = new MemTransport();
  const bus = busWith(fake, "p");
  const r = new ConnectorRegistrar(bus, { id: "discord", kind: "discord", version: "0.1.0", intervalMs: 5000, capabilities: () => caps() });
  await r.tick();
  const set = fake.of("writeRegistration")[0]!;
  assert.equal(bus.connectorKey("discord"), "p:connector:discord");
  assert.equal(set.args[0], "discord");
  assert.equal(set.args[2], 15000);
  const reg = JSON.parse(set.args[1] as string);
  assert.equal(reg.v, 1);
  assert.equal(reg.id, "discord");
  assert.equal(reg.capabilities[0].transport, "stream");
  assert.deepEqual(Object.keys(reg).sort(), ["capabilities", "detail", "id", "instance", "intervalMs", "kind", "pid", "startedAt", "state", "v", "version"]);
  assert.equal(fake.of("append").length, 0, "not a stream entry");
  await bus.stop();
});

// @spec CONN-REG-001
test("transport http is carried through for audio-in", async () => {
  const fake = new MemTransport();
  const bus = busWith(fake);
  const r = new ConnectorRegistrar(bus, { id: "desktop", kind: "desktop", version: "1", capabilities: () => [{ cap: "audio-in", tag: "desktop", format: { rate: 16000, channels: 1 }, ready: true, transport: "http" }] });
  await r.tick();
  assert.equal((await bus.readRegistration("desktop"))!.capabilities[0]!.transport, "http");
  await bus.stop();
});

// @spec CONN-REG-002
test("start rewrites the registration every interval", async () => {
  const fake = new MemTransport();
  const bus = busWith(fake);
  const r = new ConnectorRegistrar(bus, { id: "discord", kind: "discord", version: "1", intervalMs: 10, capabilities: () => caps() });
  await r.start();
  await tick(60);
  await r.stop();
  assert.ok(fake.writes >= 3, `wrote ${fake.writes}`);
  await bus.stop();
});

// @spec CONN-REG-003
test("an orderly stop deletes the registration", async () => {
  const fake = new MemTransport();
  const bus = busWith(fake);
  const r = new ConnectorRegistrar(bus, { id: "discord", kind: "discord", version: "1", capabilities: () => caps() });
  await r.tick();
  assert.equal(fake.kv.size, 1);
  await r.stop();
  assert.equal(fake.kv.size, 0);
  await bus.stop();
});

// @spec CONN-REG-004
test("a second instance replaces the registration at once and the first stops registering and does not delete it", async () => {
  const fake = new MemTransport();
  const bus = busWith(fake);
  let displaced = 0;
  const a = new ConnectorRegistrar(bus, { id: "discord", kind: "discord", version: "1", capabilities: () => caps() }, () => displaced++);
  const b = new ConnectorRegistrar(bus, { id: "discord", kind: "discord", version: "1", capabilities: () => caps() });
  await a.tick();
  await b.tick();
  assert.equal((await bus.readRegistration("discord"))!.instance, b.instance);
  const writes = fake.writes;
  await a.tick();
  assert.equal(displaced, 1);
  assert.equal(fake.writes, writes);
  await a.stop();
  assert.equal((await bus.readRegistration("discord"))!.instance, b.instance);
  await bus.stop();
});

// @spec CONN-REG-005
test("an unknown capability is ignored and the rest of the registration is used", () => {
  const raw = JSON.stringify({ v: 1, id: "x", kind: "k", version: "1", instance: "i", pid: 1, startedAt: 1, intervalMs: 5000, state: "ready", detail: "", capabilities: [
    { cap: "chat-in", tag: "twitch" }, { cap: "audio-in", tag: "mic", format: { rate: 16000, channels: 1 }, ready: true },
  ] });
  const reg = parseRegistration(raw)!;
  assert.deepEqual(reg.capabilities.map((c) => c.tag), ["mic"]);
  assert.equal(reg.capabilities[0]!.transport, "stream");
  assert.equal(parseRegistration("not json"), undefined);
  assert.equal(parseRegistration(JSON.stringify({ v: 2 })), undefined);
});

// @spec CONN-REG-006
test("a tag is available only while a live registration offers it ready; the registry is read by key listing", async () => {
  const fake = new MemTransport();
  const bus = busWith(fake);
  const a = new ConnectorRegistrar(bus, { id: "discord", kind: "discord", version: "1", capabilities: () => caps(false) });
  await a.tick();
  const regs = await bus.listConnectors();
  assert.equal(regs.length, 1);
  assert.ok(findOffer(regs, "audio-in", "discord"));
  assert.equal(findReady(regs, "audio-in", "discord"), undefined);
  const b = new ConnectorRegistrar(bus, { id: "other", kind: "k", version: "1", capabilities: () => [{ cap: "audio-in", tag: "mic", format: { rate: 16000, channels: 1 }, ready: true }] });
  await b.tick();
  assert.equal(findReady(await bus.listConnectors(), "audio-in", "mic")!.reg.id, "other");
  assert.equal(findReady(await bus.listConnectors(), "audio-out", "mic"), undefined);
  await bus.stop();
});

// @spec CONN-REG-006
test("watchConnectors reports a connector appearing and disappearing without a restart", async () => {
  const fake = new MemTransport();
  const bus = busWith(fake);
  const seen: string[][] = [];
  const w = watchConnectors(bus, (regs) => seen.push(regs.map((r) => r.id)), 5);
  await tick(20);
  const a = new ConnectorRegistrar(bus, { id: "discord", kind: "discord", version: "1", capabilities: () => caps() });
  await a.tick();
  await tick(30);
  await a.stop();
  await tick(30);
  w.stop();
  assert.deepEqual(seen, [[], ["discord"], []]);
  await bus.stop();
});

// @spec CONN-REG-006
test("ConnectorRegistry: start awaits the first read, answers offer and ready, and calls listeners on a change", async () => {
  const fake = new MemTransport();
  const bus = busWith(fake);
  const reg = new ConnectorRegistry(bus, 5);
  await reg.start();
  assert.equal(reg.offer("audio-in", "discord"), undefined);
  let changes = 0;
  const off = reg.on(() => changes++);
  const a = new ConnectorRegistrar(bus, { id: "discord", kind: "discord", version: "1", capabilities: () => caps() });
  await a.tick();
  await tick(30);
  assert.ok(changes >= 1);
  assert.equal(reg.offer("audio-in", "discord")?.reg.id, "discord");
  assert.equal(reg.ready("audio-in", "discord")?.cap.ready, true);
  assert.equal(reg.ready("audio-in", "nobody"), undefined);
  off();
  const before = changes;
  await a.stop();
  await tick(30);
  assert.equal(changes, before, "an unsubscribed listener is not called");
  assert.equal(reg.offer("audio-in", "discord"), undefined, "a removed registration is gone from the view");
  reg.stop();
  await bus.stop();
});

// @spec CONN-REG-007
test("the heartbeat is published on the health stream by the same tick", async () => {
  const fake = new MemTransport();
  const bus = busWith(fake, "p");
  const r = new ConnectorRegistrar(bus, {
    id: "discord", kind: "discord", version: "1", capabilities: () => caps(),
    heartbeat: (reg) => ({ service: reg.id, instance: reg.instance, pid: reg.pid, version: reg.version, startedAt: reg.startedAt, state: "ready", deps: {}, mode: "live", intervalMs: reg.intervalMs }),
  });
  await r.tick();
  assert.equal(fake.heartbeats.length, 1);
  assert.equal(fake.writes, 1);
  await bus.stop();
});

// @spec CONN-TAG-001, CONN-TAG-002
test("tags follow the grammar and the reserved ones are refused", async () => {
  assert.equal(tagProblem("discord"), null);
  assert.equal(tagProblem("mic-2"), null);
  for (const bad of ["", "Discord", "1mic", "a_b", "x".repeat(33)]) assert.ok(tagProblem(bad), bad);
  for (const r of ["http", "dir", "dashboard", "mouth", "dryrun", "file"]) assert.match(tagProblem(r)!, /reserved/);
  const bus = busWith(new MemTransport());
  assert.throws(() => new ConnectorRegistrar(bus, { id: "x", kind: "x", version: "1", capabilities: () => [{ cap: "audio-in", tag: "http", format: { rate: 1, channels: 1 }, ready: true }] }), /reserved/);
  assert.throws(() => new ConnectorRegistrar(bus, { id: "Bad", kind: "x", version: "1", capabilities: () => [] }));
  await bus.stop();
});

// @spec CONN-TAG-003, CONN-TAG-004
test("a tag another live connector serves in the same direction is refused and reported degraded; the other direction is independent", async () => {
  const fake = new MemTransport();
  const bus = busWith(fake);
  const first = new ConnectorRegistrar(bus, { id: "discord", kind: "discord", version: "1", capabilities: () => [caps()[0]!] });
  await first.tick();
  const second = new ConnectorRegistrar(bus, { id: "rival", kind: "k", version: "1", capabilities: () => caps() });
  await second.tick();
  const reg = (await bus.readRegistration("rival"))!;
  assert.equal(reg.state, "degraded");
  assert.match(reg.detail, /discord is served by discord/);
  assert.deepEqual(reg.capabilities.map((c) => c.cap), ["audio-out"]); // sink discord is free: separate namespaces
  // retried each interval: the first leaves, the second takes the source
  await first.stop();
  await second.tick();
  const again = (await bus.readRegistration("rival"))!;
  assert.equal(again.state, "ready");
  assert.equal(again.capabilities.length, 2);
  await bus.stop();
});

// @spec CONN-AUD-002
test("a frame round-trips through its stream fields", () => {
  const f = frame({ utt: "u9", last: true, spk: undefined, name: undefined });
  const fields = encodeFrame(f);
  assert.equal(fields[fields.indexOf("v") + 1], "1");
  const d = decodeFrame(fields.map((x) => (Buffer.isBuffer(x) ? x : Buffer.from(x))));
  assert.ok(d.ok);
  assert.deepEqual(d.frame, { epoch: 100, seq: 0, rate: 16000, ch: 1, pcm: f.pcm, utt: "u9", last: true });
  const inn = decodeFrame(encodeFrame(frame()));
  assert.ok(inn.ok && inn.frame.spk === "u1" && inn.frame.name === "Ann" && inn.frame.last === undefined);
  const seq = new FrameSequencer(5);
  assert.deepEqual([seq.epoch, seq.next(), seq.next()], [5, 0, 1]);
});

// @spec CONN-AUD-001, BUS-AUD-001, CONN-BP-001
test("frames go to the transport's audio stream of their direction and tag; publish never writes them", async () => {
  const fake = new MemTransport();
  const bus = busWith(fake, "p");
  await bus.publishFrame("in", "discord", frame());
  await bus.publishFrame("out", "discord", frame({ rate: 48000, ch: 2, utt: "u" }));
  assert.deepEqual(fake.of("appendFrame").map((c) => [c.args[0], c.args[1]]), [["in", "discord"], ["out", "discord"]]);
  assert.equal(bus.audioStream("in", "discord"), "p:audio.in.discord");
  assert.equal(bus.audioStream("out", "discord"), "p:audio.out.discord");
  assert.deepEqual(AUDIO_MAXLEN, { in: 3000, out: 1500 });
  await bus.publish("chat.message", { platform: "twitch", user: "a", text: "hi" });
  assert.equal(fake.of("appendFrame").length, 2, "publish writes no frame");
  assert.deepEqual(fake.of("append").map((c) => c.args[0]), ["events"]);
  await bus.stop();
});

// @spec CONN-BP-002
test("a consumer reads live: its own reader's readFrames from $, no group, no ack", async () => {
  const fake = new MemTransport();
  const bus = busWith(fake, "p");
  const done = bus.tailAudio("in", "discord", () => {});
  await tick(10);
  assert.deepEqual(fake.of("readFrames")[0]!.args, ["in", "discord", "$", 100, 5000]);
  assert.equal(fake.of("createGroup").length + fake.of("readGroup").length + fake.of("ack").length, 0);
  await bus.stop();
  await done;
});

// @spec CONN-BP-002
test("tailAudio hands each entry on decoded, advances from the last id, and survives a handler throw", async () => {
  const fake = new MemTransport();
  fake.on("readFrames", () => [
    { id: "5-0", decoded: { ok: true, frame: frame({ seq: 0 }) } }, { id: "5-1", decoded: { ok: true, frame: frame({ seq: 1 }) } },
  ]);
  const bus = busWith(fake, "p");
  const got: number[] = [];
  const done = bus.tailAudio("in", "discord", (d) => { if (d.ok) got.push(d.frame.seq); if (got.length === 1) throw new Error("boom"); });
  await tick(20);
  assert.deepEqual(got, [0, 1]);
  assert.equal(fake.of("readFrames")[1]!.args[2], "5-1");
  await bus.stop();
  await done;
});

// @spec CONN-AUD-003, CONN-BP-003, CONN-BP-006
test("the tracker drops wrong-format and malformed frames, counts gaps, and resets on a new epoch", () => {
  const t = new FrameTracker({ rate: 16000, channels: 1 });
  const ok = (f: Frame) => t.accept(decodeFrame(encodeFrame(f)));
  assert.ok(ok(frame({ seq: 0 })));
  assert.ok(ok(frame({ seq: 1 })));
  assert.ok(ok(frame({ seq: 4 })));
  assert.equal(t.lost, 2);
  assert.equal(ok(frame({ seq: 5, rate: 48000 })), undefined); // wrong rate
  assert.equal(ok(frame({ seq: 6, ch: 2 })), undefined);
  assert.equal(t.dropped, 2);
  assert.ok(ok(frame({ epoch: 200, seq: 0 }))); // restart: no loss counted
  assert.equal(t.lost, 2);
  const bad: (string | Buffer)[][] = [
    [], // no fields
    encodeFrame(frame()).map((x, i) => (i === 1 ? "2" : x)), // version
    encodeFrame({ ...frame(), pcm: Buffer.alloc(3) }), // odd
    encodeFrame({ ...frame(), pcm: Buffer.alloc(MAX_FRAME_BYTES + 2) }), // size
    encodeFrame(frame()).filter((x) => !Buffer.isBuffer(x) || x.length !== 640).filter((x) => x !== "pcm"), // no pcm
  ];
  for (const fields of bad) assert.equal(t.accept(decodeFrame(fields)), undefined);
  assert.equal(t.dropped, 2 + bad.length);
  assert.equal(t.summary(), `lost 2, dropped ${2 + bad.length}`);
  assert.ok(ok(frame({ epoch: 200, seq: 1 }))); // keeps running
});

// ---- flush (barge-in): a producer's stop of a line, written as a pcm-less frame

const flushFrame = (over: Partial<Frame> = {}): Frame => ({ epoch: 100, seq: 3, rate: 48000, ch: 2, utt: "u9", flush: true, ...over } as Frame);

// @spec CONN-REG-001, CONN-FLUSH-001
test("an audio-out capability may carry flush true; an entry without it means the connector does not obey a flush frame", async () => {
  const fake = new MemTransport();
  const bus = busWith(fake);
  const r = new ConnectorRegistrar(bus, {
    id: "discord", kind: "discord", version: "1",
    capabilities: () => [
      { cap: "audio-out", tag: "discord", format: { rate: 48000, channels: 2 }, ready: true, flush: true },
      { cap: "audio-in", tag: "discord", format: { rate: 16000, channels: 1 }, ready: true },
    ] as CapabilityEntry[],
  });
  await r.tick();
  const reg = (await bus.readRegistration("discord"))!;
  const out = reg.capabilities.find((c) => c.cap === "audio-out") as unknown as { flush?: boolean };
  const inn = reg.capabilities.find((c) => c.cap === "audio-in") as unknown as { flush?: boolean };
  assert.equal(out.flush, true, "flush true survives write and parse");
  assert.ok(!inn.flush, "an entry without flush stays without it");
  await bus.stop();
});

// @spec CONN-AUD-002, CONN-AUD-006
test("a flush frame round-trips: flush 1, utt, the producer's seq and epoch, rate and ch, and no pcm", () => {
  const fields = encodeFrame(flushFrame());
  assert.equal(fields[fields.indexOf("flush") + 1], "1");
  assert.equal(fields.includes("pcm"), false, "no pcm field is written");
  assert.equal(fields[fields.indexOf("utt") + 1], "u9");
  const d = decodeFrame(fields.map((x) => (Buffer.isBuffer(x) ? x : Buffer.from(x))));
  assert.ok(d.ok, "a flush frame is not malformed");
  const f = d.frame as Frame & { flush?: boolean };
  assert.equal(f.flush, true);
  assert.deepEqual([f.epoch, f.seq, f.rate, f.ch, f.utt], [100, 3, 48000, 2, "u9"]);
  assert.ok(f.pcm === undefined || f.pcm.length === 0);
  const plain = decodeFrame(encodeFrame({ epoch: 1, seq: 0, rate: 48000, ch: 2, pcm: Buffer.alloc(4), utt: "u" }));
  assert.ok(plain.ok && !(plain.frame as { flush?: boolean }).flush, "an ordinary frame carries no flush");
});

// @spec CONN-AUD-006, CONN-BP-006
test("the tracker accepts a flush frame without counting it malformed or lost; a frame with neither pcm nor flush is still malformed", () => {
  const t = new FrameTracker({ rate: 48000, channels: 2 });
  const pcmFrame = (seq: number): Frame => ({ epoch: 100, seq, rate: 48000, ch: 2, pcm: Buffer.alloc(3840), utt: "u9" });
  const accept = (f: Frame) => t.accept(decodeFrame(encodeFrame(f)));
  assert.ok(accept(pcmFrame(0)));
  assert.ok(accept(pcmFrame(1)));
  assert.ok(accept(pcmFrame(2)));
  const flushed = accept(flushFrame({ seq: 3 }));
  assert.ok(flushed, "accepted");
  assert.equal((flushed as { flush?: boolean }).flush, true);
  assert.ok(accept(pcmFrame(4)), "the next line follows the flush's seq");
  assert.equal(t.dropped, 0);
  assert.equal(t.lost, 0, "a flush frame is not a lost frame and leaves no gap");
  const noPcmNoFlush = encodeFrame(pcmFrame(5)).filter((x, i, a) => x !== "pcm" && !(Buffer.isBuffer(x) && a[i - 1] === "pcm"));
  assert.equal(t.accept(decodeFrame(noPcmNoFlush)), undefined);
  assert.equal(t.dropped, 1);
});
