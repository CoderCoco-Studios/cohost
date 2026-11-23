import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeBus, event, silentLog, testConfig } from "@cohost/testing";
import { Eyes, createDescriber } from "../src/eyes.js";
import { createInjectHandler } from "../src/inject.js";
import { JPEG_BYTES, serveModel } from "./support.js";

const run = async (h: { (ev: never): void; drain(): Promise<void> }, ev: unknown): Promise<void> => { h(ev as never); await h.drain(); };

const UP = "0123456789abcdef0123456789abcdef";

function setup(reply: string | Error = "a menu screen", over: { bytes?: Buffer | null; take?: (id: string) => Promise<Buffer | null>; now?: () => number; uploadTimeoutMs?: number; uploadMaxBytes?: number } = {}) {
  const bus = new FakeBus();
  const taken: string[] = [];
  const bytes = over.bytes === undefined ? Buffer.from("IMG") : over.bytes;
  bus.takeUpload = over.take ?? (async (id) => { taken.push(id); return bytes; });
  const described: [string, string][] = [];
  const handle = createInjectHandler({
    bus, log: silentLog,
    describe: async (b64, prev) => { described.push([b64, prev]); if (reply instanceof Error) throw reply; return reply; },
    now: over.now, uploadTimeoutMs: over.uploadTimeoutMs, uploadMaxBytes: over.uploadMaxBytes,
  });
  return { bus, handle, taken, described };
}
const req = (over: Record<string, unknown> = {}) =>
  event("inject.request", { id: "i1", target: "eyes", kind: "image", uploadId: UP, contentType: "image/png", remember: false, ...over });

// @spec EYES-INJ-007
// @spec EYES-INJ-017
test("image described: base64 bytes, empty previous, injected vision.summary then ok result", async () => {
  const t = setup();
  await run(t.handle, req());
  assert.deepEqual(t.taken, [UP]);
  assert.deepEqual(t.described, [[Buffer.from("IMG").toString("base64"), ""]]);
  assert.deepEqual(t.bus.of("vision.summary"), [{ text: "a menu screen", changed: true, injected: true, remember: false }]);
  assert.deepEqual(t.bus.of("inject.result"), [{ id: "i1", ok: true, detail: "a menu screen" }]);
});

// @spec EYES-INJ-007
test("remember flag is carried", async () => {
  const t = setup();
  await run(t.handle, req({ remember: true }));
  assert.equal(t.bus.of("vision.summary")[0]!.remember, true);
});

// @spec EYES-INJ-008
test("SAME or empty reply: ok:false, no summary", async () => {
  for (const reply of ["SAME", "same.", ""]) {
    const t = setup(reply);
    await run(t.handle, req());
    assert.equal(t.bus.of("vision.summary").length, 0);
    assert.equal(t.bus.of("inject.result")[0]!.ok, false);
  }
});

// @spec EYES-INJ-008
test("a reply that merely starts with Same is a description and is published", async () => {
  const t = setup("Same old menu screen, but the cursor moved.");
  await run(t.handle, req());
  assert.equal(t.bus.of("vision.summary").length, 1);
  assert.equal(t.bus.of("inject.result")[0]!.ok, true);
});

// @spec EYES-INJ-016
test("eyes takes injection through the shared handler: target eyes, the single kind image, the configured cap and timeout", async () => {
  const t = setup("a menu screen", { uploadMaxBytes: 2 });
  await run(t.handle, req({ kind: "text", text: "hi" }));
  assert.deepEqual(t.bus.of("inject.result")[0], { id: "i1", ok: false, detail: "eyes cannot handle kind 'text'" });
  await run(t.handle, req({ id: "i2", target: "chat" }));
  assert.equal(t.bus.of("inject.result").length, 1, "another target's request is ignored");
  await run(t.handle, req({ id: "i3" }));
  assert.match(t.bus.of("inject.result")[1]!.detail ?? "", /2 byte limit/);
  const slow = setup("x", { uploadTimeoutMs: 20, take: () => new Promise(() => {}) });
  await run(slow.handle, req({ id: "i4" }));
  assert.match(slow.bus.of("inject.result")[0]!.detail ?? "", /timed out after 20 ms/);
});

// @spec EYES-INJ-009
test("model failure: ok:false with the error, no summary", async () => {
  const t = setup(new Error("vision model 503"));
  await run(t.handle, req());
  assert.equal(t.bus.of("vision.summary").length, 0);
  const [r] = t.bus.of("inject.result");
  assert.equal(r!.ok, false);
  assert.match(r!.detail!, /vision model 503/);
});

// @spec SHARED-INJ-004
test("a request without a well-formed upload id reads nothing", async () => {
  for (const uploadId of ["http://evil.example/uploads/abc", "../secret", "garbage", undefined]) {
    const t = setup();
    await run(t.handle, req({ uploadId }));
    assert.deepEqual(t.taken, [], String(uploadId));
    assert.equal(t.described.length, 0);
    assert.deepEqual(t.bus.of("inject.result")[0], { id: "i1", ok: false, detail: "request carries no upload id" });
  }
});

// @spec SHARED-INJ-013
test("an expired or missing upload: ok:false `upload expired or missing`, model not called", async () => {
  const t = setup("x", { bytes: null });
  await run(t.handle, req());
  assert.equal(t.described.length, 0);
  assert.deepEqual(t.bus.of("inject.result"), [{ id: "i1", ok: false, detail: "upload expired or missing" }]);
});

// @spec SHARED-INJ-001, SHARED-INJ-002
test("stale request: only ok:false stale; other target ignored", async () => {
  const stale = setup("x", { now: () => Date.now() + 61_000 });
  await run(stale.handle, req());
  assert.deepEqual(stale.bus.of("inject.result"), [{ id: "i1", ok: false, detail: "stale" }]);
  assert.equal(stale.described.length, 0);
  const other = setup();
  await run(other.handle, req({ target: "ears", kind: "audio" }));
  assert.equal(other.bus.published.length, 0);
});

// @spec EYES-INJ-010, EYES-INJ-011
test("injection does not disturb look()'s previous description (works with no OBS: only describe is used)", async () => {
  const bus = new FakeBus();
  const previous: string[] = [];
  const replies = ["first look", "second look"];
  const describe = async (_b: string, prev: string) => { previous.push(prev); return replies.shift() ?? "an injected frame"; };
  bus.takeUpload = async () => Buffer.from("IMG");
  const eyes = new Eyes({ bus, log: silentLog, screenshot: async () => "B", describe });
  const handle = createInjectHandler({ bus, log: silentLog, describe });
  await eyes.look();
  await run(handle, req());
  await eyes.look();
  assert.deepEqual(previous, ["", "", "first look"]);
});

// @spec SHARED-INJ-006
test("an upload read that does not finish within the timeout: ok:false naming the timeout, model not called", async () => {
  const t = setup("x", { take: () => new Promise(() => {}), uploadTimeoutMs: 20 });
  await run(t.handle, req());
  const [r] = t.bus.of("inject.result");
  assert.equal(r!.ok, false);
  assert.match(r!.detail!, /timed out after 20 ms/);
  assert.equal(t.described.length, 0);
  assert.equal(t.bus.of("vision.summary").length, 0);
});

// @spec SHARED-INJ-007
test("an upload over vision.upload_max_bytes is rejected naming the limit; model not called", async () => {
  const t = setup("x", { bytes: Buffer.alloc(10), uploadMaxBytes: 5 });
  await run(t.handle, req());
  assert.equal(t.bus.of("inject.result")[0]!.ok, false);
  assert.match(t.bus.of("inject.result")[0]!.detail!, /5 byte limit/);
  assert.equal(t.described.length, 0);
});

// @spec SHARED-INJ-007
test("an upload exactly at the limit is accepted", async () => {
  const t = setup("a menu", { bytes: Buffer.alloc(5), uploadMaxBytes: 5 });
  await run(t.handle, req());
  assert.equal(t.bus.of("inject.result")[0]!.ok, true);
});

/** The handler wired to the describer `vision.provider` selects, the way the service wires it. */
function viaProvider(over: Record<string, unknown>) {
  const bus = new FakeBus();
  bus.takeUpload = async () => JPEG_BYTES;
  const cfg = testConfig(over);
  return { bus, handle: createInjectHandler({ bus, log: silentLog, describe: createDescriber(cfg) }) };
}

// @spec EYES-INJ-018
test("an injected image is described through vision.provider: an OpenAI-compatible server gets the frame and its summary is published", async () => {
  const m = await serveModel("A menu screen.");
  const t = viaProvider({ llm: { openai: { base_url: m.url } }, vision: { enabled: false, provider: "openai", model: "vision-model" } });
  await run(t.handle, req({ contentType: "image/jpeg" }));
  assert.equal(m.seen.length, 1);
  assert.equal(m.seen[0]!.url, "/chat/completions");
  assert.equal(m.seen[0]!.body.model, "vision-model");
  assert.deepEqual(t.bus.of("inject.result"), [{ id: "i1", ok: true, detail: "A menu screen." }]);
  assert.deepEqual(t.bus.of("vision.summary"), [{ text: "A menu screen.", changed: true, injected: true, remember: false }]);
});

// @spec EYES-GAP-004, EYES-GAP-005
test("an image injected while vision.model is blank answers ok:false `vision.model is not set`, publishes no summary, and the handler keeps answering", async () => {
  const m = await serveModel();
  const saved = process.env.OLLAMA_URL;
  process.env.OLLAMA_URL = m.url;
  try {
    const t = viaProvider({ vision: { provider: "ollama", model: "" } });
    await run(t.handle, req({ id: "i1" }));
    await run(t.handle, req({ id: "i2" }));
    assert.deepEqual(t.bus.of("inject.result"), [
      { id: "i1", ok: false, detail: "vision.model is not set" },
      { id: "i2", ok: false, detail: "vision.model is not set" },
    ]);
    assert.equal(t.bus.of("vision.summary").length, 0);
    assert.deepEqual(m.seen, []);
  } finally { if (saved === undefined) delete process.env.OLLAMA_URL; else process.env.OLLAMA_URL = saved; }
});

// @spec EYES-GAP-003, EYES-GAP-004
test("an image injected while anthropic has no api key answers ok:false naming llm.claude.api_key", async () => {
  const t = viaProvider({ vision: { provider: "anthropic", model: "claude-vision" } });
  await run(t.handle, req());
  const [r] = t.bus.of("inject.result");
  assert.equal(r!.ok, false);
  assert.match(r!.detail!, /llm\.claude\.api_key is not set/);
  assert.equal(t.bus.of("vision.summary").length, 0);
});

// @spec EYES-PROV-007
test("a 400 from the provider for the injected frame answers ok:false with the provider's error and publishes no summary", async () => {
  const m = await serveModel();
  m.state.status = 400;
  const t = viaProvider({ llm: { openai: { base_url: m.url } }, vision: { provider: "openai", model: "vision-model" } });
  await run(t.handle, req());
  const [r] = t.bus.of("inject.result");
  assert.equal(r!.ok, false);
  assert.match(r!.detail!, /openai chat 400/);
  assert.equal(t.bus.of("vision.summary").length, 0);
});

// @spec EYES-PROV-007, EYES-INJ-018
test("an injected BMP or PDF answers ok:false with the model layer's message, publishes no summary, and the handler keeps answering", async () => {
  const bmp = Buffer.from("BM\x36\x00\x00\x00\x00\x00\x00\x00\x36\x00\x00\x00", "latin1");
  const pdf = Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1");
  const m = await serveModel();
  const bus = new FakeBus();
  let next = bmp;
  bus.takeUpload = async () => next;
  const handle = createInjectHandler({ bus, log: silentLog, describe: createDescriber(testConfig({ llm: { openai: { base_url: m.url } }, vision: { provider: "openai", model: "vision-model" } })) });
  await run(handle, req({ id: "i1" }));
  next = pdf;
  await run(handle, req({ id: "i2" }));
  assert.deepEqual(bus.of("inject.result"), [
    { id: "i1", ok: false, detail: "image data is not JPEG, PNG, GIF or WebP" },
    { id: "i2", ok: false, detail: "image data is not JPEG, PNG, GIF or WebP" },
  ]);
  assert.equal(bus.of("vision.summary").length, 0);
  assert.deepEqual(m.seen, []);
});
