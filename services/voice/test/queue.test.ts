import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { FakeBus, event, recordingLog } from "@cohost/testing";
import { wavWrap } from "@cohost/shared";
import { Voice } from "../src/voice.js";

const say = (id: string, text = "hello chat") => event("brain.say", { id, text, emotion: "happy", gesture: "wave" });
const halfSecond = wavWrap(Buffer.alloc(12000 * 2), 24000, 1);

function setup(synth: (t: string) => Promise<Buffer> = async () => halfSecond) {
  const bus = new FakeBus();
  const rec = recordingLog();
  const voice = new Voice({ bus, log: rec.log, synth, publicUrl: "http://voice:8700" });
  return { voice, bus, rec };
}

async function sayAndWait(voice: Voice, ev: ReturnType<typeof say>): Promise<void> {
  await voice.onEvent(ev);
  await voice.whenIdle();
}

const flush = () => new Promise((r) => setImmediate(r));
const deferred = () => { let release!: () => void; const gate = new Promise<void>((r) => { release = r; }); return { gate, release }; };
const httpStatus = (voice: Voice, id: string) => {
  let code = 0;
  voice.handle({ method: "GET", url: `/audio/${id}.wav` } as never, { writeHead: (c: number) => { code = c; }, end() {} } as never);
  return code;
};

beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
afterEach(() => mock.timers.reset());

// @spec VOICE-SYN-007
test("brain.say is queued: the read loop returns at once, lines synthesize one at a time in arrival order", async () => {
  const order: string[] = [];
  let active = 0;
  let maxActive = 0;
  const gates = new Map<string, ReturnType<typeof deferred>>();
  const { voice, bus } = setup(async (t) => {
    order.push(t); active++; maxActive = Math.max(maxActive, active);
    const g = deferred(); gates.set(t, g);
    await g.gate;
    active--;
    return halfSecond;
  });
  await voice.onEvent(say("a", "first")); // resolves while "first" is still synthesizing
  await voice.onEvent(say("b", "second"));
  await flush();
  assert.deepEqual(order, ["first"]);
  gates.get("first")!.release();
  await flush();
  assert.deepEqual(order, ["first", "second"]);
  gates.get("second")!.release();
  await voice.whenIdle();
  assert.equal(maxActive, 1);
  assert.deepEqual(bus.of("voice.utterance").map((u) => u.id), ["a", "b"]);
});

// @spec VOICE-SYN-007
test("a claim for an earlier line is read while a later line synthesizes, so no spurious virtual pair follows", async () => {
  const g = deferred();
  let n = 0;
  const { voice, bus } = setup(async () => { if (++n === 2) await g.gate; return halfSecond; });
  try {
    await sayAndWait(voice, say("u1"));
    await voice.onEvent(say("u2")); // synthesis of u2 is held open
    await flush();
    await voice.onEvent(event("voice.playing", { id: "u1", sink: "discord" })); // read during u2's synthesis
    mock.timers.tick(1500);
    await flush();
    assert.deepEqual(bus.of("voice.playing"), []); // u1 was claimed in time
  } finally {
    g.release();
    await voice.whenIdle();
  }
});

// @spec VOICE-SYN-007
test("a failure while reporting a failed synthesis is logged and the queue keeps draining", async () => {
  let n = 0;
  const { voice, bus, rec } = setup(async () => { if (++n === 1) throw new Error("tts 500"); return halfSecond; });
  const publish = bus.publish.bind(bus);
  let first = true;
  bus.publish = (async (...a: Parameters<typeof publish>) => {
    if (a[0] === "voice.done" && first) { first = false; throw new Error("redis down"); }
    return publish(...a);
  }) as typeof bus.publish;
  await voice.onEvent(say("a"));
  await voice.onEvent(say("b"));
  await voice.whenIdle();
  assert.deepEqual(bus.of("voice.utterance").map((u) => u.id), ["b"]);
  assert.ok(rec.msgs("error").includes("synthesis failed"));
});

// @spec VOICE-SYN-008, VOICE-HLTH-005
test("stop drops queued lines, keeps an in-flight line from publishing, and clears the claim-window and virtual-done timers", async () => {
  const g = deferred();
  let n = 0;
  const { voice, bus } = setup(async () => { if (++n === 3) await g.gate; return halfSecond; });
  try {
    await sayAndWait(voice, say("u1"));
    mock.timers.tick(1500);
    await flush(); // u1's virtual playing is out, its virtual done pending
    await sayAndWait(voice, say("u2")); // claim window pending
    await voice.onEvent(say("u3")); // in flight
    await voice.onEvent(say("u4")); // queued
    await flush();
    bus.clear();
    voice.stop();
  } finally {
    g.release();
    await voice.whenIdle();
  }
  mock.timers.tick(60_000);
  await flush();
  assert.deepEqual(bus.published, []);
  assert.equal(n, 3, "the queued line was never synthesized");
  await voice.onEvent(say("u5"));
  await voice.whenIdle();
  assert.equal(n, 3, "a stopped service takes no new lines");
});

// @spec VOICE-HTTP-008
test("re-synthesizing a stored id replaces its audio and makes it the newest, so eviction never removes a live id", async () => {
  const { voice } = setup();
  await sayAndWait(voice, say("a"));
  await sayAndWait(voice, say("b"));
  await sayAndWait(voice, say("a")); // reuse
  for (let i = 0; i < 48; i++) await sayAndWait(voice, say(`n${i}`)); // 50 distinct ids: a, b, n0..n47
  assert.equal(httpStatus(voice, "a"), 200);
  assert.equal(httpStatus(voice, "b"), 200);
  await sayAndWait(voice, say("z")); // the 51st distinct id evicts the oldest, which is b (a was refreshed)
  assert.equal(httpStatus(voice, "b"), 404);
  assert.equal(httpStatus(voice, "a"), 200);
  assert.equal(httpStatus(voice, "z"), 200);
});

// @spec VOICE-HTTP-006, VOICE-HTTP-007
test("HTTP: GET and HEAD only, and the path is matched without its query string", async () => {
  mock.timers.reset(); // real timers for the HTTP round-trips
  const { voice } = setup();
  await sayAndWait(voice, say("abc"));
  const server = http.createServer(voice.handle);
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const q = await fetch(`${base}/audio/abc.wav?t=1`);
    assert.equal(q.status, 200);
    assert.deepEqual(Buffer.from(await q.arrayBuffer()), halfSecond);
    assert.equal((await fetch(`${base}/audio/nope.wav?t=1`)).status, 404);
    assert.equal(await (await fetch(`${base}/health?probe=1`)).text(), "ok");
    const head = await fetch(`${base}/audio/abc.wav`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-type"), "audio/wav");
    assert.equal(head.headers.get("content-length"), String(halfSecond.length));
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    assert.equal((await fetch(`${base}/health`, { method: "HEAD" })).status, 200);
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const r = await fetch(`${base}/audio/abc.wav`, { method });
      assert.equal(r.status, 405, method);
      assert.equal(r.headers.get("allow"), "GET, HEAD");
    }
    assert.equal((await fetch(`${base}/other`, { method: "POST" })).status, 405);
  } finally { server.close(); }
});

// @spec VOICE-ENV-005
test("a WAV the shared parser rejects (no fmt chunk) takes the tts failed path", async () => {
  const noFmt = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE"), Buffer.from("data"), Buffer.from([4, 0, 0, 0]), Buffer.alloc(4)]);
  const { voice, bus, rec } = setup(async () => noFmt);
  await sayAndWait(voice, say("u1"));
  assert.deepEqual(bus.published, [{ type: "voice.done", data: { id: "u1", sink: "error" } }]);
  assert.deepEqual(rec.msgs("error"), ["tts failed"]);
});
