import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConnectorRegistry } from "@cohost/bus";
import { ConnectorFakeBus, FakeBus, recordingLog, waitFor } from "@cohost/testing";
import { wavWrap } from "@cohost/shared";
import { ClipCache, type FallbackClip } from "../src/clips.js";
import { ClaimMemory, FallbackLine } from "../src/fallback.js";
import { createConnectorOutput } from "../src/connector-output.js";
import { createFileOutput } from "../src/file-output.js";
import { createHttpOutput, type HttpPost } from "../src/http-output.js";
import { Playback } from "../src/playback.js";

// Per-clause behaviour of the outputs (MOUTH-FILE-001, MOUTH-HTTP-002, 004, MOUTH-FALL-009, CONN-AUD-005, 008).
// Seam: playback.enqueue(id, url, { text, durationMs, seq?, more? }) as in clauses.test.ts.

const wav = (ms: number, fill = 0) => wavWrap(Buffer.alloc(24 * ms * 2, fill), 24000, 1);
const U = (seq: number, more?: true) => ({ text: `t${seq}`, durationMs: 10, seq, ...(more ? { more } : {}) });
type Out = { playback: { enqueue(...a: never[]): Promise<void> } };
const put = (o: Out, id: string, seq: number, utt: unknown = U(seq, seq === 0 ? true : undefined)) =>
  (o.playback.enqueue as unknown as (id: string, url: string, utt: unknown) => Promise<void>)(id, `http://voice/${id}-${seq}.wav`, utt);

// @spec MOUTH-FILE-001
test("file: a streamed line is one file per clause, named with the clause's seq", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mouth-clause-file-"));
  const bus = new FakeBus();
  const out = createFileOutput({ bus, log: recordingLog().log, dir, maxFiles: 10, fetchAudio: async () => wav(10, 1) });
  try {
    await put(out, "u1", 0);
    await waitFor(() => bus.of("voice.done").length === 1, "clause 0 done");
    await put(out, "u1", 1);
    await waitFor(() => bus.of("voice.done").length === 2, "clause 1 done");
    const files = readdirSync(dir).sort();
    assert.equal(files.length, 2);
    assert.match(files[0]!, /^\d+-\d+-u1-0\.wav$/);
    assert.match(files[1]!, /^\d+-\d+-u1-1\.wav$/);
    assert.deepEqual(bus.of("voice.playing").map((p) => p.seq), [0, 1]);
  } finally { out.close(); rmSync(dir, { recursive: true, force: true }); }
});

function http(over: { maxQueue?: number; gate?: Promise<void> } = {}) {
  const bus = new FakeBus();
  const rec = recordingLog();
  const calls: { headers: Record<string, string> }[] = [];
  const post: HttpPost = async (_url, init) => { calls.push({ headers: init.headers }); await over.gate; return { status: 200 }; };
  const out = createHttpOutput({
    bus, log: rec.log, url: "http://sink.test/ingest", timeoutMs: 1000, retries: 0, maxQueue: over.maxQueue ?? 20,
    fetchAudio: async () => wav(5), post, backoff: { baseMs: 1, maxMs: 2, sleep: async () => {} },
  });
  return { out, bus, rec, calls };
}

// @spec MOUTH-HTTP-002
test("http: each clause is POSTed with x-cohost-utterance-id and x-cohost-clause set to its seq", async () => {
  const { out, calls } = http();
  try {
    await put(out, "u1", 0);
    await waitFor(() => calls.length === 1, "post 0");
    await new Promise((r) => setTimeout(r, 20));
    await put(out, "u1", 1);
    await waitFor(() => calls.length === 2, "post 1");
    assert.deepEqual(calls.map((c) => [c.headers["x-cohost-utterance-id"], c.headers["x-cohost-clause"], c.headers["content-type"]]), [
      ["u1", "0", "audio/wav"], ["u1", "1", "audio/wav"],
    ]);
  } finally { out.close(); }
});

// @spec MOUTH-HTTP-004
test("http: past max_queue undelivered clauses the oldest clause is dropped with the warning and every clause still reports playing and done", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const { out, bus, rec, calls } = http({ maxQueue: 1, gate });
  try {
    for (const seq of [0, 1, 2, 3]) { await put(out, "u1", seq); await new Promise((r) => setTimeout(r, 15)); }
    await waitFor(() => calls.length === 1, "the first delivery is in flight");
    assert.ok(rec.msgs("warn").filter((m) => m === "http output: queue full, dropped oldest undelivered line").length >= 1);
    release();
    await waitFor(() => bus.of("voice.done").length === 4, "all four clauses done");
    assert.deepEqual(bus.of("voice.playing").map((p) => p.seq), [0, 1, 2, 3], "no effect on the reports");
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(calls.map((c) => c.headers["x-cohost-clause"]), ["0", "3"], "clauses 1 and 2 were dropped as each newer one arrived: the oldest undelivered one goes");
  } finally { release(); out.close(); }
});

// @spec MOUTH-FALL-009
test("a give-up on a clause claimed by another real sink plays no fallback, while an unclaimed clause of the same line does", async () => {
  const bus = new FakeBus();
  const cache = new ClipCache();
  const body = wav(100);
  const clip: FallbackClip = { name: "c", text: "oops", durationMs: 100, bytes: body.length, sha256: "x", wav: body };
  cache.replace({ fingerprint: "fp", clips: [clip] });
  const claims = new ClaimMemory() as unknown as ClaimMemory & { claim(id: string, sink: string, seq?: number): void };
  claims.claim("u1", "dashboard", 1);
  const fallback = new FallbackLine({ cache, claims, sink: "discord", minIntervalMs: 0, random: () => 0 });
  const p = new Playback({
    bus, log: recordingLog().log, sink: "discord", gainDb: 0, fallback,
    fetchAudio: async (u) => { if (!u.includes("-0")) throw new Error("fetch audio 404"); return wavWrap(Buffer.alloc(4800), 24000, 1); },
    play: () => {},
  });
  await (p.enqueue as unknown as (id: string, url: string, utt: unknown) => Promise<void>)("u1", "http://voice/u1-0.wav", U(0, true));
  await p.onIdle();
  await (p.enqueue as unknown as (id: string, url: string, utt: unknown) => Promise<void>)("u1", "http://voice/u1-1.wav", U(1));
  assert.deepEqual(bus.of("voice.failed").map((f) => [f.seq, f.fallback]), [[1, undefined]], "clause 1 was claimed by the dashboard: no clip");
  assert.equal(bus.of("voice.playing").filter((e) => e.seq === 1).length, 0);
});

// ---- connector output frames (CONN-AUD-005, CONN-AUD-008)

const sinkReg = [{ cap: "audio-out" as const, tag: "discord", format: { rate: 48000, channels: 2 }, ready: true, transport: "stream" as const, flush: true }];

async function discord(ms: number | ((url: string) => number)) {
  const bus = new ConnectorFakeBus();
  bus.register("discord", sinkReg);
  const registry = new ConnectorRegistry(bus as never, 10);
  await registry.start();
  const out = createConnectorOutput({ bus: bus as never, registry, log: recordingLog().log, tag: "discord", gainDb: () => 0, fetchAudio: async (u) => wav(typeof ms === "function" ? ms(u) : ms, 1) });
  return { bus, out, stop: () => { out.close(); registry.stop(); } };
}

// @spec CONN-AUD-005
test("discord: every frame of a clause carries utt <id>-<seq> and only the clause's last frame is marked last", async () => {
  const r = await discord(60);
  try {
    await put(r.out, "u1", 0);
    await waitFor(() => r.bus.published.filter((p) => p.type === "voice.done").length === 1, "clause 0 done");
    await put(r.out, "u1", 1);
    await waitFor(() => r.bus.published.filter((p) => p.type === "voice.done").length === 2, "clause 1 done");
    const frames = r.bus.frames;
    const by = (utt: string) => frames.filter((f) => f.frame.utt === utt);
    assert.equal(by("u1-0").length + by("u1-1").length, frames.length, "no frame carries the bare line id");
    for (const key of ["u1-0", "u1-1"]) {
      const f = by(key);
      assert.ok(f.length > 1);
      assert.deepEqual(f.map((x) => x.frame.last === true), f.map((_, i) => i === f.length - 1));
    }
  } finally { r.stop(); }
});

// @spec CONN-AUD-008, MOUTH-STOP-003
test("discord: a stop's flush frame carries the line id as utt, not the clause key, after a later clause is current", async () => {
  const r = await discord((u) => (u.includes("-0") ? 40 : 3000));
  try {
    await put(r.out, "u1", 0);
    await waitFor(() => r.bus.published.filter((p) => p.type === "voice.done").length === 1, "clause 0 done");
    await put(r.out, "u1", 1);
    await (r.out as unknown as { stop(o: { ids: string[] }): Promise<void> }).stop({ ids: ["u1"] });
    const flush = r.bus.frames.map((f) => f.frame as unknown as Record<string, unknown>).filter((f) => f.flush === true);
    assert.equal(flush.length, 1);
    assert.equal(flush[0]!.utt, "u1");
    const done = r.bus.published.filter((p) => p.type === "voice.done").map((p) => p.data as Record<string, unknown>);
    assert.equal(done.length, 2);
    assert.deepEqual([done[1]!.seq, done[1]!.interrupted], [1, true]);
  } finally { r.stop(); }
});
