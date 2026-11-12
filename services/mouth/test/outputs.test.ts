import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeBus, recordingLog, waitFor } from "@cohost/testing";
import { wavWrap } from "@cohost/shared";
import { createFileOutput } from "../src/file-output.js";
import { createHttpOutput, type HttpPost } from "../src/http-output.js";

const wav = (ms: number, fill = 0) => wavWrap(Buffer.alloc(24 * ms * 2, fill), 24000, 1);

function tmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "mouth-out-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

// ---- file output

// @spec MOUTH-FILE-001
test("file: writes each line's WAV under the directory (created on demand), claims it, and releases it after the WAV's duration", () => tmp(async (root) => {
  const bus = new FakeBus();
  const dir = join(root, "nested", "outputs");
  const body = wav(60, 1);
  const out = createFileOutput({ bus, log: recordingLog().log, dir, maxFiles: 10, fetchAudio: async () => body });
  try {
    assert.equal(out.name, "file");
    assert.equal(out.isReady(), true);
    const t0 = performance.now();
    await out.playback.enqueue("u1", "http://voice/u1.wav");
    const files = readdirSync(dir);
    assert.equal(files.length, 1);
    assert.match(files[0]!, /^\d+-\d+-u1\.wav$/);
    assert.ok(readFileSync(join(dir, files[0]!)).equals(body), "the WAV unchanged (MOUTH-SINK-001)");
    assert.deepEqual(bus.published, [{ type: "voice.playing", data: { id: "u1", sink: "file" } }]);
    await waitFor(() => bus.of("voice.done").length === 1, "voice.done");
    assert.ok(performance.now() - t0 >= 55, "released after the duration, not at once");
    assert.deepEqual(bus.of("voice.done"), [{ id: "u1", sink: "file" }]);
  } finally {
    out.close();
  }
}));

// @spec MOUTH-FILE-002
test("file: keeps only the newest max_files .wav files and touches nothing else", () => tmp(async (dir) => {
  const bus = new FakeBus();
  writeFileSync(join(dir, "notes.txt"), "keep me");
  const out = createFileOutput({ bus, log: recordingLog().log, dir, maxFiles: 2, fetchAudio: async () => wav(5) });
  try {
    for (const id of ["a", "b", "c", "d"]) {
      await out.playback.enqueue(id, `http://voice/${id}.wav`);
      await waitFor(() => bus.of("voice.done").some((d) => d.id === id), `done ${id}`);
    }
    const left = readdirSync(dir).sort();
    assert.equal(left.filter((f) => f.endsWith(".wav")).length, 2);
    assert.deepEqual(left.filter((f) => f.endsWith(".wav")).map((f) => f.replace(/^\d+-\d+-/, "")), ["c.wav", "d.wav"], "the oldest were deleted");
    assert.ok(left.includes("notes.txt"));
  } finally {
    out.close();
  }
}));

// @spec MOUTH-FILE-003, MOUTH-SINK-001
test("file: a directory that cannot be created gives up on the line with voice.failed under sink file and no fallback", () => tmp(async (root) => {
  const bus = new FakeBus();
  writeFileSync(join(root, "blocked"), "a file, not a directory");
  const out = createFileOutput({ bus, log: recordingLog().log, dir: join(root, "blocked", "outputs"), maxFiles: 2, fetchAudio: async () => wav(5) });
  try {
    await out.playback.enqueue("u1", "http://voice/u1.wav");
    assert.equal(bus.of("voice.playing").length, 0);
    const failed = bus.of("voice.failed");
    assert.equal(failed.length, 1);
    assert.equal(failed[0]!.sink, "file");
    assert.equal(failed[0]!.fallback, undefined);
    assert.ok(!existsSync(join(root, "blocked", "outputs")));
  } finally {
    out.close();
  }
}));

// ---- http output

interface Call { url: string; headers: Record<string, string>; body: Buffer; signal: AbortSignal }
function rig(over: { postImpl?: (c: Call, n: number) => Promise<{ status: number }>; url?: string; retries?: number; maxQueue?: number; timeoutMs?: number; lineMs?: number } = {}) {
  const bus = new FakeBus();
  const rec = recordingLog();
  const calls: Call[] = [];
  const post: HttpPost = async (url, init) => {
    const c = { url, headers: init.headers, body: init.body, signal: init.signal };
    calls.push(c);
    return over.postImpl ? over.postImpl(c, calls.length) : { status: 200 };
  };
  const out = createHttpOutput({
    bus, log: rec.log, url: over.url ?? "http://sink.test/ingest", timeoutMs: over.timeoutMs ?? 1000, retries: over.retries ?? 3, maxQueue: over.maxQueue ?? 20,
    fetchAudio: async (url) => wav(over.lineMs ?? 10, url.endsWith("bad.wav") ? 0 : 2), post,
    backoff: { baseMs: 1, maxMs: 2, sleep: async () => {} },
  });
  return { out, bus, rec, calls };
}

// @spec MOUTH-HTTP-001, MOUTH-HTTP-002
test("http: claims the line, POSTs the WAV with its id and content type, and releases after the duration even while the delivery is still pending", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const { out, bus, calls } = rig({ lineMs: 40, postImpl: async () => { await gate; return { status: 204 }; } });
  try {
    assert.equal(out.name, "http");
    assert.equal(out.isReady(), true);
    await out.playback.enqueue("u1", "http://voice/u1.wav");
    assert.deepEqual(bus.published, [{ type: "voice.playing", data: { id: "u1", sink: "http" } }]);
    await waitFor(() => calls.length === 1, "the POST");
    assert.equal(calls[0]!.url, "http://sink.test/ingest");
    assert.equal(calls[0]!.headers["content-type"], "audio/wav");
    assert.equal(calls[0]!.headers["x-cohost-utterance-id"], "u1");
    assert.ok(calls[0]!.body.equals(wav(40, 2)), "the WAV unchanged (MOUTH-SINK-001)");
    await waitFor(() => bus.of("voice.done").length === 1, "voice.done while the POST is pending");
    assert.deepEqual(bus.of("voice.done"), [{ id: "u1", sink: "http" }]);
  } finally {
    release();
    out.close();
  }
});

// @spec MOUTH-HTTP-003
test("http: a failed attempt (error, then a 500) is retried and the line is delivered on the third attempt", async () => {
  const { out, calls, rec } = rig({ retries: 3, postImpl: async (_c, n) => { if (n === 1) throw new Error("ECONNRESET"); return { status: n === 2 ? 500 : 200 }; } });
  try {
    await out.playback.enqueue("u1", "http://voice/u1.wav");
    await waitFor(() => calls.length === 3, "three attempts");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(calls.length, 3, "stops after the first success");
    assert.ok(!rec.msgs("warn").includes("http output: dropped undelivered line"));
  } finally {
    out.close();
  }
});

// @spec MOUTH-HTTP-003
test("http: after `retries` retries the line is dropped with a warning and the next line is still delivered", async () => {
  const { out, calls, rec, bus } = rig({ retries: 2, lineMs: 5, postImpl: async (c) => ({ status: c.headers["x-cohost-utterance-id"] === "bad" ? 503 : 200 }) });
  try {
    await out.playback.enqueue("bad", "http://voice/bad.wav");
    await out.playback.enqueue("good", "http://voice/good.wav");
    await waitFor(() => rec.msgs("warn").includes("http output: dropped undelivered line"), "the drop warning");
    await waitFor(() => calls.some((c) => c.headers["x-cohost-utterance-id"] === "good"), "the next line delivered");
    assert.equal(calls.filter((c) => c.headers["x-cohost-utterance-id"] === "bad").length, 3, "the first attempt plus two retries");
    assert.deepEqual(bus.of("voice.failed"), [], "a failed delivery is not a give-up: the line already played");
  } finally {
    out.close();
  }
});

// @spec MOUTH-HTTP-002, MOUTH-HTTP-003
test("http: an attempt is abandoned after timeout_ms (its signal aborts) and counts as a failure", async () => {
  const { out, calls } = rig({
    timeoutMs: 30, retries: 1,
    postImpl: async (c, n) => {
      if (n > 1) return { status: 200 };
      await new Promise<void>((_, reject) => c.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      return { status: 200 };
    },
  });
  try {
    await out.playback.enqueue("u1", "http://voice/u1.wav");
    await waitFor(() => calls.length === 2, "the retry after the timeout");
    assert.equal(calls[0]!.signal.aborted, true);
  } finally {
    out.close();
  }
});

// @spec MOUTH-HTTP-004
test("http: past max_queue undelivered lines the oldest is dropped with a warning; playback is unaffected", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const { out, calls, rec, bus } = rig({ maxQueue: 2, lineMs: 5, postImpl: async (c) => { if (c.headers["x-cohost-utterance-id"] === "l1") await gate; return { status: 200 }; } });
  try {
    for (const id of ["l1", "l2", "l3", "l4", "l5"]) {
      await out.playback.enqueue(id, `http://voice/${id}.wav`);
      await waitFor(() => bus.of("voice.done").some((d) => d.id === id), `done ${id}`);
    }
    assert.equal(bus.of("voice.playing").length, 5, "all five claimed");
    assert.equal(rec.msgs("warn").filter((m) => m === "http output: queue full, dropped oldest undelivered line").length, 2);
    release();
    await waitFor(() => calls.length === 3, "l1 and the two newest delivered");
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(calls.map((c) => c.headers["x-cohost-utterance-id"]), ["l1", "l4", "l5"]);
  } finally {
    release();
    out.close();
  }
});

// @spec MOUTH-HTTP-005
test("http: an empty url logs an error naming the key, keeps the output not ready and never POSTs", async () => {
  const { out, rec, calls } = rig({ url: "" });
  try {
    assert.equal(out.isReady(), false);
    assert.ok(rec.msgs("error").some((m) => m.includes("mouth.outputs.http.url")), rec.msgs("error").join());
    assert.equal(calls.length, 0);
  } finally {
    out.close();
  }
});

// @spec MOUTH-HTTP-006
test("http: close stops delivering and retrying", async () => {
  const bus = new FakeBus();
  let attempts = 0;
  const out = createHttpOutput({
    bus, log: recordingLog().log, url: "http://sink.test/x", timeoutMs: 1000, retries: 50, maxQueue: 5,
    fetchAudio: async () => wav(5), post: async () => { attempts++; return { status: 500 }; },
    backoff: { baseMs: 5, maxMs: 5 },
  });
  await out.playback.enqueue("u1", "http://voice/u1.wav");
  await waitFor(() => attempts >= 2, "retrying");
  out.close();
  await new Promise((r) => setTimeout(r, 20));
  const after = attempts;
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(attempts, after, "no attempt after close");
});

// @spec MOUTH-SINK-001
test("http: a line it cannot fetch is reported voice.failed under sink http with no fallback and nothing is delivered", async () => {
  const bus = new FakeBus();
  const calls: unknown[] = [];
  const out = createHttpOutput({
    bus, log: recordingLog().log, url: "http://sink.test/x", timeoutMs: 100, retries: 0, maxQueue: 5,
    fetchAudio: async () => { throw new Error("voice down"); }, post: async (...a) => { calls.push(a); return { status: 200 }; },
  });
  try {
    await out.playback.enqueue("u1", "http://voice/u1.wav");
    assert.equal(bus.of("voice.failed").length, 1);
    assert.equal(bus.of("voice.failed")[0]!.sink, "http");
    assert.equal(bus.of("voice.failed")[0]!.fallback, undefined);
    assert.equal(calls.length, 0);
  } finally {
    out.close();
  }
});
