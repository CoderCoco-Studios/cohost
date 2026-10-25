import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeBus, event, silentLog } from "@cohost/testing";
import { wavWrap } from "../src/audio.js";
import { createInjectHandler, wavDurationMs } from "../src/inject.js";

const DASH = "http://dashboard:3000";
const UP = `${DASH}/uploads/abc123`;

function setup(reply: string | Error = "hello there", opts: { body?: Buffer; type?: string; fetch?: typeof fetch; now?: () => number } = {}) {
  const bus = new FakeBus();
  const fetched: string[] = [];
  const sent: { len: number; type?: string }[] = [];
  const body = opts.body ?? wavWrap(Buffer.alloc(32000), 16000, 1); // 1 s
  const handle = createInjectHandler({
    bus, log: silentLog, dashboardUrl: DASH,
    fetch: opts.fetch ?? (async (u) => { fetched.push(String(u)); return new Response(body, { headers: { "content-type": opts.type ?? "audio/wav" } }); }),
    transcribe: async (a, hint) => { sent.push({ len: a.length, type: hint?.contentType }); if (reply instanceof Error) throw reply; return reply; },
    now: opts.now,
  });
  return { bus, handle, fetched, sent, body };
}
const req = (over: Record<string, unknown> = {}) =>
  event("inject.request", { id: "a1", target: "ears", kind: "audio", url: UP, remember: false, ...over });

test("transcribed: bytes unchanged to STT, injected speech.heard with speaker and WAV duration, ok result", async () => {
  const t = setup();
  await t.handle(req({ meta: { user: "alice" } }));
  assert.deepEqual(t.sent, [{ len: t.body.length, type: "audio/wav" }]);
  assert.deepEqual(t.bus.of("speech.heard"), [{ speaker: "alice", text: "hello there", durationMs: 1000, injected: true, remember: false }]);
  assert.deepEqual(t.bus.of("inject.result"), [{ id: "a1", ok: true, detail: "hello there" }]);
});

test("default speaker 'injected', remember carried; short clips are still transcribed", async () => {
  const t = setup("hi", { body: wavWrap(Buffer.alloc(320), 16000, 1) });
  await t.handle(req({ remember: true }));
  const [s] = t.bus.of("speech.heard");
  assert.equal(s!.speaker, "injected");
  assert.equal(s!.remember, true);
  assert.equal(s!.durationMs, 10);
});

test("non-WAV upload: duration 0, content type passed to STT", async () => {
  const t = setup("hi", { body: Buffer.from("OggS...."), type: "audio/ogg" });
  await t.handle(req());
  assert.equal(t.bus.of("speech.heard")[0]!.durationMs, 0);
  assert.equal(t.sent[0]!.type, "audio/ogg");
});

test("empty / non-word transcript: ok:false, no speech.heard", async () => {
  for (const reply of ["", "  ", "...", "!?"]) {
    const t = setup(reply);
    await t.handle(req());
    assert.equal(t.bus.of("speech.heard").length, 0);
    assert.equal(t.bus.of("inject.result")[0]!.ok, false);
  }
});

test("STT failure: ok:false with detail", async () => {
  const t = setup(new Error("stt 503: down"));
  await t.handle(req());
  assert.equal(t.bus.of("speech.heard").length, 0);
  assert.match(t.bus.of("inject.result")[0]!.detail!, /stt 503/);
});

test("foreign URL: nothing fetched, ok:false", async () => {
  const t = setup();
  await t.handle(req({ url: "http://evil.example/uploads/x" }));
  assert.deepEqual(t.fetched, []);
  assert.equal(t.sent.length, 0);
  assert.equal(t.bus.of("inject.result")[0]!.ok, false);
});

test("stale request and other target", async () => {
  const stale = setup("x", { now: () => Date.now() + 61_000 });
  await stale.handle(req());
  assert.deepEqual(stale.bus.of("inject.result"), [{ id: "a1", ok: false, detail: "stale" }]);
  const other = setup();
  await other.handle(req({ target: "eyes", kind: "image" }));
  assert.equal(other.bus.published.length, 0);
});

test("wavDurationMs: 0 for non-WAV or garbage", () => {
  assert.equal(wavDurationMs(Buffer.from("nope")), 0);
  assert.equal(wavDurationMs(wavWrap(Buffer.alloc(96000), 48000, 1)), 1000);
});
