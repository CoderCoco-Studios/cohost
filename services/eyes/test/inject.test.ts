import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeBus, event, silentLog } from "@cohost/testing";
import { Eyes } from "../src/eyes.js";
import { createInjectHandler } from "../src/inject.js";

const run = async (h: { (ev: never): void; drain(): Promise<void> }, ev: unknown): Promise<void> => { h(ev as never); await h.drain(); };

const DASH = "http://dashboard:3000";
const UP = `${DASH}/uploads/abc123`;

function setup(reply: string | Error = "a menu screen", over: { fetch?: typeof fetch; now?: () => number; uploadTimeoutMs?: number; uploadMaxBytes?: number } = {}) {
  const bus = new FakeBus();
  const fetched: string[] = [];
  const described: [string, string][] = [];
  const handle = createInjectHandler({
    bus, log: silentLog, dashboardUrl: DASH,
    fetch: over.fetch ?? (async (u) => { fetched.push(String(u)); return new Response(Buffer.from("IMG")); }),
    describe: async (b64, prev) => { described.push([b64, prev]); if (reply instanceof Error) throw reply; return reply; },
    now: over.now, uploadTimeoutMs: over.uploadTimeoutMs, uploadMaxBytes: over.uploadMaxBytes,
  });
  return { bus, handle, fetched, described };
}
const req = (over: Record<string, unknown> = {}) =>
  event("inject.request", { id: "i1", target: "eyes", kind: "image", url: UP, remember: false, ...over });

// @spec EYES-INJ-007
test("image described: base64 bytes, empty previous, injected vision.summary then ok result", async () => {
  const t = setup();
  await run(t.handle, req());
  assert.deepEqual(t.fetched, [UP]);
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
test("foreign URLs are never fetched", async () => {
  for (const url of ["http://evil.example/uploads/abc", "http://dashboard:3000/other/abc", `${DASH}/uploads/../secret`, "http://user@dashboard:3000/uploads/a", "file:///etc/passwd", "garbage", undefined]) {
    const t = setup();
    await run(t.handle, req({ url }));
    assert.deepEqual(t.fetched, [], String(url));
    assert.equal(t.described.length, 0);
    assert.equal(t.bus.of("inject.result")[0]!.ok, false, String(url));
  }
});

// @spec SHARED-INJ-005
test("fetch failure (404): ok:false without calling the model", async () => {
  const t = setup("x", { fetch: async () => new Response("gone", { status: 404 }) });
  await run(t.handle, req());
  assert.equal(t.described.length, 0);
  assert.match(t.bus.of("inject.result")[0]!.detail!, /404/);
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
  const eyes = new Eyes({ bus, log: silentLog, screenshot: async () => "B", describe });
  const handle = createInjectHandler({ bus, log: silentLog, dashboardUrl: DASH, describe, fetch: async () => new Response("IMG") });
  await eyes.look();
  await run(handle, req());
  await eyes.look();
  assert.deepEqual(previous, ["", "", "first look"]);
});

// @spec SHARED-INJ-006
test("an upload fetch that does not finish within the timeout is aborted: ok:false naming the timeout, model not called", async () => {
  const hang: typeof fetch = (_u, init) => new Promise((_res, rej) => {
    init!.signal!.addEventListener("abort", () => rej(init!.signal!.reason));
  });
  const t = setup("x", { fetch: hang, uploadTimeoutMs: 20 });
  await run(t.handle, req());
  const [r] = t.bus.of("inject.result");
  assert.equal(r!.ok, false);
  assert.match(r!.detail!, /timed out after 20 ms/);
  assert.equal(t.described.length, 0);
  assert.equal(t.bus.of("vision.summary").length, 0);
});

// @spec SHARED-INJ-006
test("a body that stalls after the headers is also cut off by the timeout", async () => {
  const stall: typeof fetch = async (_u, init) => {
    const body = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new Uint8Array([1])); init!.signal!.addEventListener("abort", () => c.error(init!.signal!.reason)); },
    });
    return new Response(body);
  };
  const t = setup("x", { fetch: stall, uploadTimeoutMs: 20 });
  await run(t.handle, req());
  assert.match(t.bus.of("inject.result")[0]!.detail!, /timed out after 20 ms/);
  assert.equal(t.described.length, 0);
});

// @spec SHARED-INJ-007
test("a body over vision.upload_max_bytes is rejected naming the limit, whether declared or streamed; model not called", async () => {
  const declared = setup("x", { fetch: async () => new Response(Buffer.alloc(10), { headers: { "content-length": "10" } }), uploadMaxBytes: 5 });
  await run(declared.handle, req());
  assert.equal(declared.bus.of("inject.result")[0]!.ok, false);
  assert.match(declared.bus.of("inject.result")[0]!.detail!, /5 byte limit/);
  assert.equal(declared.described.length, 0);

  let pulled = 0;
  const streamed = setup("x", {
    fetch: async () => new Response(new ReadableStream<Uint8Array>({
      pull(c) { pulled++; c.enqueue(new Uint8Array(4)); }, // no content-length: endless 4-byte chunks
    })),
    uploadMaxBytes: 10,
  });
  await run(streamed.handle, req());
  assert.match(streamed.bus.of("inject.result")[0]!.detail!, /10 byte limit/);
  assert.ok(pulled < 10, `stopped reading after the limit (pulled ${pulled})`);
  assert.equal(streamed.described.length, 0);
});

// @spec SHARED-INJ-007
test("a body exactly at the limit is accepted", async () => {
  const t = setup("a menu", { fetch: async () => new Response(Buffer.alloc(5)), uploadMaxBytes: 5 });
  await run(t.handle, req());
  assert.equal(t.bus.of("inject.result")[0]!.ok, true);
});
