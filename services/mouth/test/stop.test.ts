import { test } from "node:test";
import assert from "node:assert/strict";
import { ConnectorRegistry } from "@cohost/bus";
import { ConnectorFakeBus, FakeBus, event, recordingLog, waitFor } from "@cohost/testing";
import { wavWrap } from "@cohost/shared";
import { ClipCache, type FallbackClip } from "../src/clips.js";
import { ClaimMemory, FallbackLine } from "../src/fallback.js";
import { createConnectorOutput } from "../src/connector-output.js";
import { createDryrunOutput } from "../src/dryrun.js";
import { createFileOutput } from "../src/file-output.js";
import { Playback } from "../src/playback.js";
import { createMouthHandler } from "../src/session.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// voice.stop on the mouth outputs (MOUTH-STOP-*). Seams the code phase provides (named here, adjustable by the code phase):
//   - MouthOutput.stop(order: { ids?: string[] }): Promise<void>, and Playback.stop(order) behind it
//   - playback.enqueue(id, url, utt?: { text: string; durationMs: number }), the third argument carrying what spokenText needs
//   - an optional `now: () => number` in DryrunDeps and PlaybackDeps (the discord output keeps using clock.now)

const wav = (ms: number) => wavWrap(Buffer.alloc(24 * ms * 2), 24000, 1);
const clip = (ms: number): FallbackClip => { const body = wav(ms); return { name: "00-clip.wav", text: "Error: unable to play line.", durationMs: ms, bytes: body.length, sha256: "x", wav: body }; };
const stopEv = (ids?: string[]) => event("voice.stop" as never, { reason: "barge-in", ...(ids ? { ids } : {}) } as never);
type Stoppable = { stop(order: { ids?: string[] }): Promise<void> };
const stopOf = (o: unknown) => (o as Stoppable).stop.bind(o) as Stoppable["stop"];
const UTT = (text: string, durationMs: number) => ({ text, durationMs });
const enqueue = (o: { playback: { enqueue: (...a: never[]) => Promise<void> } }, id: string, utt?: { text: string; durationMs: number }) =>
  (o.playback.enqueue as unknown as (id: string, url: string, utt?: unknown) => Promise<void>)(id, `http://voice/${id}.wav`, utt);
const deferred = () => { let release!: () => void; let fail!: (e: Error) => void; const gate = new Promise<void>((r, j) => { release = r; fail = j; }); return { gate, release, fail }; };
const settle = () => new Promise((r) => setTimeout(r, 30));

function dry(opts: { lineMs?: number; clips?: FallbackClip[]; now?: () => number; fetch?: (url: string) => Promise<Buffer>; failEvery?: number } = {}) {
  const bus = new FakeBus();
  const rec = recordingLog();
  const cache = new ClipCache();
  cache.replace({ fingerprint: "fp", clips: opts.clips ?? [] });
  const fallback = new FallbackLine({ cache, claims: new ClaimMemory(), sink: "dryrun", minIntervalMs: 0, random: () => 0 });
  const out = createDryrunOutput({
    bus, log: rec.log, failEvery: opts.failEvery ?? 0, fallback,
    fetchAudio: opts.fetch ?? (async () => wav(opts.lineMs ?? 5000)),
    ...(opts.now ? { now: opts.now } : {}),
  } as never);
  return { out, bus, rec };
}

// @spec MOUTH-STOP-001
test("the loop handler passes a voice.stop to every output, ready or not, as one order", async () => {
  const seen: [string, unknown][] = [];
  const mk = (name: string, ready: boolean) => ({ name, isReady: () => ready, playback: { enqueue: async () => {} }, stop: async (o: unknown) => { seen.push([name, o]); } });
  const h = createMouthHandler({ outputs: [mk("discord", false), mk("dryrun", true)] as never, log: recordingLog().log, bus: new FakeBus() });
  await h(stopEv(["a", "b"]));
  assert.deepEqual(seen, [["discord", { ids: ["a", "b"] }], ["dryrun", { ids: ["a", "b"] }]]);
  seen.length = 0;
  await h(stopEv());
  assert.equal(seen.length, 2);
  assert.equal((seen[0]![1] as { ids?: string[] }).ids, undefined, "no ids: every line");
});

// @spec MOUTH-STOP-002
test("a stop without ids empties the queue and a stop with ids removes only those, publishing nothing for them", async () => {
  const { out, bus } = dry();
  try {
    await enqueue(out, "a");
    void enqueue(out, "b"); void enqueue(out, "c"); void enqueue(out, "d");
    await stopOf(out)({ ids: ["b"] });
    await stopOf(out)({ ids: ["c", "d"] });
    await settle();
    assert.deepEqual(bus.of("voice.playing"), [{ id: "a", sink: "dryrun" }], "b, c and d never played");
    assert.deepEqual(bus.of("voice.failed"), []);
    assert.deepEqual(bus.of("voice.done"), [], "a is playing and was not named");
  } finally { out.close(); }
  const all = dry();
  try {
    await enqueue(all.out, "a");
    void enqueue(all.out, "b"); void enqueue(all.out, "c");
    await stopOf(all.out)({});
    await settle();
    assert.deepEqual(all.bus.of("voice.playing"), [{ id: "a", sink: "dryrun" }]);
    assert.deepEqual(all.bus.of("voice.done").map((d) => d.id), ["a"], "only the current item is reported, as interrupted");
  } finally { all.out.close(); }
});

// @spec MOUTH-STOP-003, MOUTH-STOP-006
test("stopping the current playing item publishes exactly one interrupted voice.done: no failed, no fallback clip, none at the end of its time", async () => {
  const { out, bus } = dry({ lineMs: 80, clips: [clip(60)] });
  try {
    await enqueue(out, "a", UTT("hello there", 80));
    await stopOf(out)({ ids: ["a"] });
    await settle();
    await new Promise((r) => setTimeout(r, 150)); // past the line's own end
    const done = bus.of("voice.done");
    assert.equal(done.length, 1);
    assert.equal(done[0]!.id, "a");
    assert.equal(done[0]!.sink, "dryrun");
    assert.equal((done[0] as { interrupted?: boolean }).interrupted, true);
    assert.deepEqual(bus.of("voice.failed"), []);
    assert.equal(bus.of("voice.playing").length, 1, "no clip played in its place");
  } finally { out.close(); }
});

// @spec MOUTH-STOP-005
test("dryrun: spokenText is the longest word-boundary prefix within elapsed/durationMs of the characters, unsaidText the rest", async () => {
  const cases: [number, string, string][] = [
    [0, "", "one two three four"],
    [2100, "one two", "three four"], // 0.525 of 18 chars = 9.45
    [2700, "one two", "three four"], // 0.675 -> 12.15: "one two three" is 13
    [3300, "one two three", "four"], // 0.825 -> 14.85
    [4000, "one two three four", ""],
    [9000, "one two three four", ""], // clamped to 1
  ];
  for (const [elapsed, spoken, unsaid] of cases) {
    let t = 0;
    const { out, bus } = dry({ lineMs: 4000, now: () => t });
    try {
      await enqueue(out, "a", UTT("one two three four", 4000));
      t = elapsed;
      await stopOf(out)({ ids: ["a"] });
      const d = bus.of("voice.done")[0] as { spokenText?: string; unsaidText?: string } | undefined;
      assert.equal(d?.spokenText, spoken, `spoken at ${elapsed}`);
      assert.equal(d?.unsaidText, unsaid, `unsaid at ${elapsed}`);
    } finally { out.close(); }
  }
});

// @spec MOUTH-STOP-005
test("a fallback clip item, and a file output item, are reported interrupted with neither spokenText nor unsaidText", async () => {
  const fb = dry({ clips: [clip(2000)], failEvery: 1 });
  try {
    await enqueue(fb.out, "a", UTT("hello there", 2000)); // gives up: the clip plays under id a and claims it
    await waitFor(() => fb.bus.of("voice.playing").length === 1, "the clip playing");
    await stopOf(fb.out)({ ids: ["a"] });
    const d = fb.bus.of("voice.done")[0] as Record<string, unknown>;
    assert.equal(d.interrupted, true);
    assert.ok(!("spokenText" in d) && !("unsaidText" in d));
  } finally { fb.out.close(); }
  const dir = mkdtempSync(join(tmpdir(), "mouth-stop-"));
  const bus = new FakeBus();
  const file = createFileOutput({ bus, log: recordingLog().log, dir, maxFiles: 5, fetchAudio: async () => wav(2000) });
  try {
    await enqueue(file, "f", UTT("hello there", 2000));
    await stopOf(file)({ ids: ["f"] });
    const d = bus.of("voice.done")[0] as Record<string, unknown>;
    assert.equal(d.interrupted, true);
    assert.ok(!("spokenText" in d) && !("unsaidText" in d));
  } finally { file.close(); rmSync(dir, { recursive: true, force: true }); }
});

// @spec MOUTH-STOP-007
test("utterances queued after a stop play in arrival order, whether or not the stopped item has ended", async () => {
  const { out, bus } = dry({ lineMs: 5000 });
  try {
    await enqueue(out, "a");
    await stopOf(out)({ ids: ["a"] });
    await enqueue(out, "b");
    void enqueue(out, "c");
    await waitFor(() => bus.of("voice.playing").some((p) => p.id === "b"), "b playing");
    assert.deepEqual(bus.of("voice.done").map((d) => d.id), ["a"]);
    await out.playback.onIdle();
    await waitFor(() => bus.of("voice.playing").some((p) => p.id === "c"), "c playing after b");
    assert.deepEqual(bus.of("voice.playing").map((p) => p.id), ["a", "b", "c"]);
  } finally { out.close(); }
});

// @spec MOUTH-STOP-008
test("a stop naming no item the output holds changes nothing and publishes nothing", async () => {
  const { out, bus } = dry({ lineMs: 120 });
  try {
    await stopOf(out)({}); // nothing held
    await stopOf(out)({ ids: [] });
    assert.deepEqual(bus.published, []);
    await enqueue(out, "a", UTT("hello there", 120));
    await stopOf(out)({ ids: ["zzz"] });
    assert.deepEqual(bus.published.map((p) => p.type), ["voice.playing"]);
    await waitFor(() => bus.of("voice.done").length === 1, "a ends normally");
    assert.deepEqual(bus.of("voice.done"), [{ id: "a", sink: "dryrun" }], "not interrupted");
  } finally { out.close(); }
});

// @spec MOUTH-STOP-009
test("a failing player stop or interrupted done publish is logged as a warning and the next queued item plays", async () => {
  const bus = new FakeBus();
  const rec = recordingLog();
  const played: string[] = [];
  const p = new Playback({
    bus, log: rec.log, sink: "discord", gainDb: 0,
    fetchAudio: async () => wavWrap(Buffer.alloc(4800), 24000, 1),
    play: (_pcm, id) => { played.push(id); },
    stop: () => { throw new Error("player stop exploded"); },
  });
  await p.enqueue("a", "http://voice/a.wav");
  void p.enqueue("b", "http://voice/b.wav");
  bus.fail = (type) => (type as string) === "voice.done";
  await (p as unknown as Stoppable).stop({ ids: ["a"] });
  await waitFor(() => played.includes("b"), "b plays after the failed stop");
  assert.ok(rec.msgs("warn").length >= 1, "a warning was logged");
  assert.deepEqual(bus.of("voice.failed"), []);
});

// @spec MOUTH-STOP-010
test("a stop naming an item still being fetched abandons it silently: no playing, done or failed, no give-up, the next item plays", async () => {
  const g = deferred();
  const { out, bus } = dry({
    clips: [clip(60)],
    fetch: async (url) => { if (url.includes("slow")) { await g.gate; throw new Error("fetch audio 500"); } return wav(5000); },
  });
  try {
    const slow = enqueue(out, "slow");
    void enqueue(out, "next");
    await settle();
    await stopOf(out)({ ids: ["slow"] });
    g.release();
    await slow;
    await waitFor(() => bus.of("voice.playing").some((p) => p.id === "next"), "next plays");
    assert.deepEqual(bus.published.map((p) => [p.type, (p.data as { id: string }).id]), [["voice.playing", "next"]], "nothing at all for slow, not even a fallback clip");
  } finally { out.close(); }
});

// ---- the discord output: frame writer abort and flush frame (MOUTH-STOP-004)

const OUT = { rate: 48000, channels: 2 };
const sinkCap = (flush: boolean) => [{ cap: "audio-out" as const, tag: "discord", format: OUT, ready: true, transport: "stream" as const, ...(flush ? { flush: true } : {}) }];

async function discord(flush: boolean, ms = 3000) {
  const bus = new ConnectorFakeBus();
  bus.register("discord", sinkCap(flush) as never);
  const registry = new ConnectorRegistry(bus as never, 10);
  await registry.start();
  let t = 0;
  const pending: (() => void)[] = [];
  const clock = { now: () => t, sleep: (ms2: number) => new Promise<void>((r) => { pending.push(() => { t += ms2; r(); }); }) };
  const out = createConnectorOutput({ bus: bus as never, registry, log: recordingLog().log, tag: "discord", gainDb: () => 0, fetchAudio: async () => wav(ms), clock });
  const at = (type: string) => bus.published.filter((p) => p.type === type).map((p) => p.data as Record<string, unknown>);
  return { bus, out, at, pending, setNow: (v: number) => { t = v; }, close: () => { out.close(); registry.stop(); } };
}

// @spec MOUTH-STOP-004
test("discord: stopping the current item aborts the frame writer first, then writes one flush frame with the next seq", async () => {
  const r = await discord(true);
  try {
    await enqueue(r.out, "u1", UTT("hello there friend", 3000));
    const before = r.bus.frames.length;
    assert.ok(before > 0 && !r.bus.frames[before - 1]!.frame.last, "mid-line: the writer is waiting on its pacing sleep");
    await stopOf(r.out)({ ids: ["u1"] });
    for (const release of r.pending.splice(0)) release(); // let the writer wake: it must write nothing more
    await settle();
    assert.equal(r.bus.frames.length, before + 1, "exactly one frame after the stop");
    const f = r.bus.frames[before]!.frame as unknown as Record<string, unknown>;
    assert.equal(f.flush, true);
    assert.equal(f.utt, "u1");
    assert.equal(f.seq, before, "the producer's next seq");
    assert.deepEqual([f.rate, f.ch], [48000, 2]);
    assert.ok(f.pcm === undefined || (f.pcm as Buffer).length === 0, "no pcm");
    assert.equal(f.epoch, r.bus.frames[0]!.frame.epoch, "the current epoch");
    const done = r.at("voice.done");
    assert.equal(done.length, 1);
    assert.equal(done[0]!.interrupted, true);
    assert.equal(done[0]!.sink, "discord");
    assert.deepEqual(r.at("voice.failed"), []);
  } finally { r.close(); }
});

// @spec MOUTH-STOP-004
test("discord: where the registration does not declare flush, no flush frame is written and the item is stopped and reported the same way", async () => {
  const r = await discord(false);
  try {
    await enqueue(r.out, "u1", UTT("hello there friend", 3000));
    const before = r.bus.frames.length;
    await stopOf(r.out)({ ids: ["u1"] });
    for (const release of r.pending.splice(0)) release();
    await settle();
    assert.equal(r.bus.frames.length, before, "the producer simply stops writing");
    assert.equal(r.at("voice.done").length, 1);
    assert.equal(r.at("voice.done")[0]!.interrupted, true);
    await new Promise((res) => setTimeout(res, 50));
    assert.equal(r.at("voice.done").length, 1, "not another at the end of the write schedule");
  } finally { r.close(); }
});

// @spec MOUTH-STOP-005
test("discord: elapsed is counted from the first frame written, so spokenText follows the clock", async () => {
  const r = await discord(true);
  try {
    await enqueue(r.out, "u1", UTT("one two three four", 4000));
    r.setNow(2100); // first frame was written at clock 0
    await stopOf(r.out)({ ids: ["u1"] });
    const d = r.at("voice.done")[0]!;
    assert.equal(d.spokenText, "one two");
    assert.equal(d.unsaidText, "three four");
  } finally { r.close(); }
});

// @spec MOUTH-STOP-009
test("discord: a flush frame write that fails is logged and the next queued item still plays", async () => {
  const r = await discord(true, 3000);
  try {
    await enqueue(r.out, "u1", UTT("hello there friend", 3000));
    void enqueue(r.out, "u2");
    r.bus.failFrames = true;
    await stopOf(r.out)({ ids: ["u1"] });
    r.bus.failFrames = false;
    for (const release of r.pending.splice(0)) release();
    await waitFor(() => r.at("voice.playing").some((p) => p.id === "u2"), "u2 plays");
  } finally { r.close(); }
});
