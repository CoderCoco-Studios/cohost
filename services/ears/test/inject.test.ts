import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeBus, event, silentLog } from "@cohost/testing";
import { wavWrap } from "@cohost/shared";
import { createInjectHandler, wavDurationMs } from "../src/inject.js";

const run = async (h: { (ev: never): void; drain(): Promise<void> }, ev: unknown): Promise<void> => { h(ev as never); await h.drain(); };

const UP = "0123456789abcdef0123456789abcdef";

function setup(reply: string | Error = "hello there", opts: { body?: Buffer | null; now?: () => number } = {}) {
  const bus = new FakeBus();
  const taken: string[] = [];
  const sent: { len: number; type?: string }[] = [];
  const body = opts.body === undefined ? wavWrap(Buffer.alloc(32000), 16000, 1) : opts.body; // 1 s
  bus.takeUpload = async (id) => { taken.push(id); return body; };
  const handle = createInjectHandler({
    bus, log: silentLog,
    transcribe: async (a, hint) => { sent.push({ len: a.length, type: hint?.contentType }); if (reply instanceof Error) throw reply; return reply; },
    now: opts.now,
  });
  return { bus, handle, taken, sent, body: body ?? Buffer.alloc(0) };
}
const req = (over: Record<string, unknown> = {}) =>
  event("inject.request", { id: "a1", target: "ears", kind: "audio", uploadId: UP, contentType: "audio/wav", remember: false, ...over });

// @spec EARS-INJ-005, EARS-INJ-006
test("transcribed: bytes unchanged to STT, injected speech.heard with speaker and WAV duration, ok result", async () => {
  const t = setup();
  await run(t.handle, req({ meta: { user: "alice" } }));
  assert.deepEqual(t.sent, [{ len: t.body.length, type: "audio/wav" }]);
  assert.deepEqual(t.bus.of("speech.heard"), [{ speaker: "alice", text: "hello there", durationMs: 1000, injected: true, remember: false }]);
  assert.deepEqual(t.bus.of("inject.result"), [{ id: "a1", ok: true, detail: "hello there" }]);
});

// @spec EARS-INJ-005, EARS-INJ-006
test("default speaker 'injected', remember carried; short clips are still transcribed", async () => {
  const t = setup("hi", { body: wavWrap(Buffer.alloc(320), 16000, 1) });
  await run(t.handle, req({ remember: true }));
  const [s] = t.bus.of("speech.heard");
  assert.equal(s!.speaker, "injected");
  assert.equal(s!.remember, true);
  assert.equal(s!.durationMs, 10);
});

// @spec EARS-INJ-005, EARS-INJ-006
test("non-WAV upload: duration 0, content type passed to STT", async () => {
  const t = setup("hi", { body: Buffer.from("OggS....") });
  await run(t.handle, req({ contentType: "audio/ogg" }));
  assert.equal(t.bus.of("speech.heard")[0]!.durationMs, 0);
  assert.equal(t.sent[0]!.type, "audio/ogg");
});

// @spec EARS-INJ-008
test("empty / non-word transcript: ok:false, no speech.heard", async () => {
  for (const reply of ["", "  ", "...", "!?"]) {
    const t = setup(reply);
    await run(t.handle, req());
    assert.equal(t.bus.of("speech.heard").length, 0);
    assert.equal(t.bus.of("inject.result")[0]!.ok, false);
  }
});

// @spec EARS-INJ-008
test("STT failure: ok:false with detail", async () => {
  const t = setup(new Error("stt 503: down"));
  await run(t.handle, req());
  assert.equal(t.bus.of("speech.heard").length, 0);
  assert.match(t.bus.of("inject.result")[0]!.detail!, /stt 503/);
});

// @spec SHARED-INJ-004, SHARED-INJ-005
test("a URL where an upload id belongs: nothing read, ok:false; a proper id is taken once", async () => {
  const t = setup();
  await run(t.handle, req({ uploadId: "http://evil.example/uploads/x" }));
  assert.deepEqual(t.taken, []);
  assert.equal(t.sent.length, 0);
  assert.equal(t.bus.of("inject.result")[0]!.ok, false);
  await run(t.handle, req({ id: "a2" }));
  assert.deepEqual(t.taken, [UP]);
});

// @spec SHARED-INJ-013
test("an expired or missing upload: ok:false, STT not called", async () => {
  const t = setup("x", { body: null });
  await run(t.handle, req());
  assert.equal(t.sent.length, 0);
  assert.deepEqual(t.bus.of("inject.result"), [{ id: "a1", ok: false, detail: "upload expired or missing" }]);
});

// @spec SHARED-INJ-001, SHARED-INJ-002
test("stale request and other target", async () => {
  const stale = setup("x", { now: () => Date.now() + 61_000 });
  await run(stale.handle, req());
  assert.deepEqual(stale.bus.of("inject.result"), [{ id: "a1", ok: false, detail: "stale" }]);
  const other = setup();
  await run(other.handle, req({ target: "eyes", kind: "image" }));
  assert.equal(other.bus.published.length, 0);
});

// @spec EARS-INJ-006
test("wavDurationMs: 0 for non-WAV or garbage", () => {
  assert.equal(wavDurationMs(Buffer.from("nope")), 0);
  assert.equal(wavDurationMs(wavWrap(Buffer.alloc(96000), 48000, 1)), 1000);
});
