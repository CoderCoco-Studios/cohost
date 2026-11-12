// Connector registry and audio streams against an in-memory fake Redis: no server required.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Bus, ConnectorRegistrar, ConnectorRegistry, FrameSequencer, FrameTracker, watchConnectors, encodeFrame, decodeFrame, parseRegistration, findReady, findOffer,
  tagProblem, AUDIO_MAXLEN, MAX_FRAME_BYTES, type Frame, type Registration, type CapabilityEntry,
} from "../src/index.js";

type Entry = [string, (string | Buffer)[]];
/** Just enough of ioredis for the registry and audio streams. */
class FakeRedis {
  kv = new Map<string, { v: string; px?: number }>();
  streams = new Map<string, Entry[]>();
  calls: unknown[][] = [];
  private n = 0;
  private waiters: ((e: Error) => void)[] = [];
  async set(k: string, v: string | Buffer, _px: string, ms: number) { this.calls.push(["set", k, v, _px, ms]); this.kv.set(k, { v: String(v), px: ms }); return "OK"; }
  async get(k: string) { return this.kv.get(k)?.v ?? null; }
  async del(k: string) { this.calls.push(["del", k]); return this.kv.delete(k) ? 1 : 0; }
  async mget(...ks: string[]) { return ks.map((k) => this.kv.get(k)?.v ?? null); }
  async scan(_c: string, _m: string, pattern: string) {
    const re = new RegExp("^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace("*", ".*") + "$");
    return ["0", [...this.kv.keys()].filter((k) => re.test(k))] as [string, string[]];
  }
  async xadd(key: string, ...a: (string | number | Buffer)[]) {
    this.calls.push(["xadd", key, ...a]);
    const star = a.indexOf("*");
    const id = `1-${this.n++}`;
    const list = this.streams.get(key) ?? [];
    list.push([id, a.slice(star + 1) as (string | Buffer)[]]);
    this.streams.set(key, list);
    return id;
  }
  async pexpire(k: string, ms: number) { this.calls.push(["pexpire", k, ms]); return 1; }
  xreadBuffer(...a: unknown[]) {
    this.calls.push(["xreadBuffer", ...a]);
    return new Promise((_, rej) => this.waiters.push(rej));
  }
  disconnect() { for (const w of this.waiters.splice(0)) w(new Error("Connection is closed.")); }
  of(m: string) { return this.calls.filter((c) => c[0] === m); }
}

const busWith = (fake: FakeRedis, prefix = "t") => new Bus("t", undefined, "redis://fake", { connect: () => fake as never, streamPrefix: prefix, retryBaseMs: 5, retryMaxMs: 20 });
const caps = (ready = true): CapabilityEntry[] => [
  { cap: "audio-in", tag: "discord", format: { rate: 16000, channels: 1 }, ready },
  { cap: "audio-out", tag: "discord", format: { rate: 48000, channels: 2 }, ready },
];
const frame = (over: Partial<Frame> = {}): Frame => ({ epoch: 100, seq: 0, rate: 16000, ch: 1, pcm: Buffer.alloc(640), spk: "u1", name: "Ann", ...over });
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

// @spec CONN-REG-001, CONN-REG-002, BUS-AUD-002
test("a registration is JSON under <prefix>:connector:<id> with a lease of three intervals, not a stream entry", async () => {
  const fake = new FakeRedis();
  const bus = busWith(fake, "p");
  const r = new ConnectorRegistrar(bus, { id: "discord", kind: "discord", version: "0.1.0", intervalMs: 5000, capabilities: () => caps() });
  await r.tick();
  const set = fake.of("set")[0]!;
  assert.equal(set[1], "p:connector:discord");
  assert.equal(set[3], "PX");
  assert.equal(set[4], 15000);
  const reg = JSON.parse(set[2] as string);
  assert.equal(reg.v, 1);
  assert.equal(reg.id, "discord");
  assert.equal(reg.capabilities[0].transport, "stream");
  assert.deepEqual(Object.keys(reg).sort(), ["capabilities", "detail", "id", "instance", "intervalMs", "kind", "pid", "startedAt", "state", "v", "version"]);
  assert.equal(fake.streams.size, 0);
  bus.stop();
});

// @spec CONN-REG-001
test("transport http is carried through for audio-in", async () => {
  const fake = new FakeRedis();
  const bus = busWith(fake);
  const r = new ConnectorRegistrar(bus, { id: "desktop", kind: "desktop", version: "1", capabilities: () => [{ cap: "audio-in", tag: "desktop", format: { rate: 16000, channels: 1 }, ready: true, transport: "http" }] });
  await r.tick();
  assert.equal((await bus.readRegistration("desktop"))!.capabilities[0]!.transport, "http");
  bus.stop();
});

// @spec CONN-REG-002
test("start rewrites the registration every interval", async () => {
  const fake = new FakeRedis();
  const bus = busWith(fake);
  const r = new ConnectorRegistrar(bus, { id: "discord", kind: "discord", version: "1", intervalMs: 10, capabilities: () => caps() });
  await r.start();
  await tick(60);
  await r.stop();
  assert.ok(fake.of("set").length >= 3, `wrote ${fake.of("set").length}`);
  bus.stop();
});

// @spec CONN-REG-003
test("an orderly stop deletes the registration", async () => {
  const fake = new FakeRedis();
  const bus = busWith(fake);
  const r = new ConnectorRegistrar(bus, { id: "discord", kind: "discord", version: "1", capabilities: () => caps() });
  await r.tick();
  assert.equal(fake.kv.size, 1);
  await r.stop();
  assert.equal(fake.kv.size, 0);
  bus.stop();
});

// @spec CONN-REG-004
test("a second instance replaces the registration at once and the first stops registering and does not delete it", async () => {
  const fake = new FakeRedis();
  const bus = busWith(fake);
  let displaced = 0;
  const a = new ConnectorRegistrar(bus, { id: "discord", kind: "discord", version: "1", capabilities: () => caps() }, () => displaced++);
  const b = new ConnectorRegistrar(bus, { id: "discord", kind: "discord", version: "1", capabilities: () => caps() });
  await a.tick();
  await b.tick();
  assert.equal((await bus.readRegistration("discord"))!.instance, b.instance);
  const writes = fake.of("set").length;
  await a.tick();
  assert.equal(displaced, 1);
  assert.equal(fake.of("set").length, writes);
  await a.stop();
  assert.equal((await bus.readRegistration("discord"))!.instance, b.instance);
  bus.stop();
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
  const fake = new FakeRedis();
  const bus = busWith(fake);
  const a = new ConnectorRegistrar(bus, { id: "discord", kind: "discord", version: "1", capabilities: () => caps(false) });
  await a.tick();
  fake.kv.set("t:unrelated", { v: "x" });
  const regs = await bus.listConnectors();
  assert.equal(regs.length, 1);
  assert.ok(findOffer(regs, "audio-in", "discord"));
  assert.equal(findReady(regs, "audio-in", "discord"), undefined);
  const b = new ConnectorRegistrar(bus, { id: "other", kind: "k", version: "1", capabilities: () => [{ cap: "audio-in", tag: "mic", format: { rate: 16000, channels: 1 }, ready: true }] });
  await b.tick();
  assert.equal(findReady(await bus.listConnectors(), "audio-in", "mic")!.reg.id, "other");
  assert.equal(findReady(await bus.listConnectors(), "audio-out", "mic"), undefined);
  bus.stop();
});

// @spec CONN-REG-006
test("watchConnectors reports a connector appearing and disappearing without a restart", async () => {
  const fake = new FakeRedis();
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
  bus.stop();
});

// @spec CONN-REG-006
test("ConnectorRegistry: start awaits the first read, answers offer and ready, and calls listeners on a change", async () => {
  const fake = new FakeRedis();
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
  bus.stop();
});

// @spec CONN-REG-007
test("the heartbeat is published on the health stream by the same tick", async () => {
  const fake = new FakeRedis();
  const bus = busWith(fake, "p");
  const r = new ConnectorRegistrar(bus, {
    id: "discord", kind: "discord", version: "1", capabilities: () => caps(),
    heartbeat: (reg) => ({ service: reg.id, instance: reg.instance, pid: reg.pid, version: reg.version, startedAt: reg.startedAt, state: "ready", deps: {}, mode: "live", intervalMs: reg.intervalMs }),
  });
  await r.tick();
  const hb = fake.streams.get("p:health")!;
  assert.equal(hb.length, 1);
  assert.equal(fake.of("set").length, 1);
  bus.stop();
});

// @spec CONN-TAG-001, CONN-TAG-002
test("tags follow the grammar and the reserved ones are refused", () => {
  assert.equal(tagProblem("discord"), null);
  assert.equal(tagProblem("mic-2"), null);
  for (const bad of ["", "Discord", "1mic", "a_b", "x".repeat(33)]) assert.ok(tagProblem(bad), bad);
  for (const r of ["http", "dir", "dashboard", "mouth", "dryrun", "file"]) assert.match(tagProblem(r)!, /reserved/);
  const bus = busWith(new FakeRedis());
  assert.throws(() => new ConnectorRegistrar(bus, { id: "x", kind: "x", version: "1", capabilities: () => [{ cap: "audio-in", tag: "http", format: { rate: 1, channels: 1 }, ready: true }] }), /reserved/);
  assert.throws(() => new ConnectorRegistrar(bus, { id: "Bad", kind: "x", version: "1", capabilities: () => [] }));
  bus.stop();
});

// @spec CONN-TAG-003, CONN-TAG-004
test("a tag another live connector serves in the same direction is refused and reported degraded; the other direction is independent", async () => {
  const fake = new FakeRedis();
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
  bus.stop();
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
test("frames go to <prefix>:audio.<dir>.<tag> with MAXLEN ~ cap and a refreshed 60 s expiry; publish never touches them", async () => {
  const fake = new FakeRedis();
  const bus = busWith(fake, "p");
  await bus.publishFrame("in", "discord", frame());
  await bus.publishFrame("out", "discord", frame({ rate: 48000, ch: 2, utt: "u" }));
  const [inn, out] = fake.of("xadd");
  assert.deepEqual(inn!.slice(0, 5), ["xadd", "p:audio.in.discord", "MAXLEN", "~", AUDIO_MAXLEN.in]);
  assert.equal(AUDIO_MAXLEN.in, 3000);
  assert.deepEqual(out!.slice(0, 5), ["xadd", "p:audio.out.discord", "MAXLEN", "~", 1500]);
  assert.deepEqual(fake.of("pexpire").map((c) => [c[1], c[2]]), [["p:audio.in.discord", 60000], ["p:audio.out.discord", 60000]]);
  await bus.publish("chat.message", { id: "1", author: "a", text: "hi", platform: "test" } as never).catch(() => {});
  assert.ok(![...fake.streams.keys()].some((k) => k === "p:events" && fake.streams.get(k)!.some((e) => e[1].includes("pcm"))));
  bus.stop();
});

// @spec CONN-BP-002
test("a consumer reads live: plain XREAD from $, no group, no ack", async () => {
  const fake = new FakeRedis();
  const bus = busWith(fake, "p");
  const done = bus.tailAudio("in", "discord", () => {});
  await tick(10);
  const call = fake.of("xreadBuffer")[0]!;
  assert.deepEqual(call.slice(1), ["COUNT", 100, "BLOCK", 5000, "STREAMS", "p:audio.in.discord", "$"]);
  assert.equal(fake.of("xgroup").length + fake.of("xack").length, 0);
  bus.stop();
  await done;
});

// @spec CONN-BP-002
test("tailAudio hands each entry on decoded, advances from the last id, and survives a handler throw", async () => {
  const fake = new FakeRedis();
  const scripted: unknown[] = [
    [["p:audio.in.discord", [[Buffer.from("5-0"), encodeFrame(frame({ seq: 0 }))], [Buffer.from("5-1"), encodeFrame(frame({ seq: 1 }))]]]],
  ];
  fake.xreadBuffer = ((...a: unknown[]) => {
    fake.calls.push(["xreadBuffer", ...a]);
    const next = scripted.shift();
    return next ? Promise.resolve(next) : new Promise((_, rej) => (fake as unknown as { waiters: ((e: Error) => void)[] }).waiters.push(rej));
  }) as never;
  const bus = busWith(fake, "p");
  const got: number[] = [];
  const done = bus.tailAudio("in", "discord", (d) => { if (d.ok) got.push(d.frame.seq); if (got.length === 1) throw new Error("boom"); });
  await tick(20);
  assert.deepEqual(got, [0, 1]);
  assert.equal(fake.of("xreadBuffer")[1]![7], "5-1");
  bus.stop();
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
