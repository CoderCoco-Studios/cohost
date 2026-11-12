import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeBus, event, silentLog } from "@cohost/testing";
import { Eyes } from "../src/eyes.js";
import { createInjectHandler } from "../src/inject.js";

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
