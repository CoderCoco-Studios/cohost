import { test } from "node:test";
import assert from "node:assert/strict";
import type { BusEvent } from "@cohost/bus";
import { INJECT_STALE_MS, createInjectHandler, subscribeInject } from "../src/index.js";

const ID = "0123456789abcdef0123456789abcdef";

type Req = BusEvent<"inject.request">["data"];
const req = (over: Partial<Req> = {}): Req => ({ id: "r1", target: "ears", kind: "audio", uploadId: ID, contentType: "audio/wav", remember: false, ...over } as Req);
const evt = (data: Req, ts = Date.now()): BusEvent<"inject.request"> => ({ id: "1", type: "inject.request", ts, source: "dashboard", data });

function setup(over: Record<string, unknown> = {}) {
  const published: { type: string; data: Record<string, unknown> }[] = [];
  const warns: unknown[] = [];
  const bus = { publish: async (type: string, data: Record<string, unknown>) => { published.push({ type, data }); return "1"; } };
  const calls: string[] = [];
  const log = { warn: (o: unknown) => warns.push(o), info() {}, error() {}, debug() {} };
  const taken: string[] = [];
  const okTake = async (id: string) => { taken.push(id); return Buffer.from([1, 2, 3]); };
  const h = createInjectHandler({
    target: "ears", bus: bus as never, log: log as never,
    kinds: { audio: async (bytes: Buffer, _r: Req, info: { contentType: string | null }) => { calls.push(`audio:${bytes.length}:${info.contentType}`); return { detail: "heard it" }; } },
    maxBytes: { audio: 1000, image: 1000 }, readTimeoutMs: 200, takeUpload: okTake,
    ...over,
  } as never);
  return { h, published, warns, calls, taken };
}
const results = (p: { type: string; data: Record<string, unknown> }[]) => p.filter((x) => x.type === "inject.result").map((x) => x.data);

// @spec SHARED-INJ-001
test("a request for another target is ignored and publishes nothing", async () => {
  const s = setup();
  s.h(evt(req({ target: "eyes" })));
  await s.h.drain();
  assert.deepEqual(s.published, []);
  assert.deepEqual(s.taken, []);
});

// @spec SHARED-INJ-002, SHARED-INJ-008
test("a request older than INJECT_STALE_MS when it leaves the queue gets `stale`, reading and calling nothing", async () => {
  const s = setup();
  s.h(evt(req(), Date.now() - INJECT_STALE_MS - 1000));
  await s.h.drain();
  assert.deepEqual(results(s.published), [{ id: "r1", ok: false, detail: "stale" }]);
  assert.deepEqual(s.taken, []);
  assert.deepEqual(s.calls, []);
  assert.equal(INJECT_STALE_MS, 60_000);
});

// @spec SHARED-INJ-002
test("staleness is judged at dequeue, so a request that waited behind a slow one goes stale", async () => {
  let t = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const s = setup({ now: () => t, kinds: { audio: async () => { await gate; return { detail: "slow" }; } } });
  s.h(evt(req({ id: "slow" }), 0));
  s.h(evt(req({ id: "waiting" }), 0));
  t = INJECT_STALE_MS + 1;
  release();
  await s.h.drain();
  assert.deepEqual(results(s.published), [{ id: "slow", ok: true, detail: "slow" }, { id: "waiting", ok: false, detail: "stale" }]);
});

// @spec SHARED-INJ-003
test("a kind the handler has no function for gets `<target> cannot handle kind '<kind>'`", async () => {
  const s = setup();
  s.h(evt(req({ kind: "image" })));
  await s.h.drain();
  assert.deepEqual(results(s.published), [{ id: "r1", ok: false, detail: "ears cannot handle kind 'image'" }]);
});

// @spec SHARED-INJ-004
test("an image or audio request with no upload id, or a malformed one, reads nothing", async () => {
  const s = setup();
  for (const uploadId of ["../etc/passwd", "ABC", "abc", "", undefined]) s.h(evt(req({ uploadId })));
  await s.h.drain();
  assert.equal(results(s.published).length, 5);
  for (const r of results(s.published)) assert.deepEqual(r, { id: "r1", ok: false, detail: "request carries no upload id" });
  assert.deepEqual(s.taken, []);
  assert.deepEqual(s.calls, []);
});

// @spec SHARED-INJ-005
test("the bytes come from takeUpload and the kind gets them with the request's content type; the key is taken exactly once", async () => {
  const s = setup();
  s.h(evt(req()));
  await s.h.drain();
  assert.deepEqual(s.taken, [ID]);
  assert.deepEqual(s.calls, ["audio:3:audio/wav"]);
  assert.deepEqual(results(s.published), [{ id: "r1", ok: true, detail: "heard it" }]);
});

// @spec SHARED-INJ-005
test("the upload is taken (so deleted) even when the kind function throws", async () => {
  const s = setup({ kinds: { audio: async () => { throw new Error("stt down"); } } });
  s.h(evt(req()));
  await s.h.drain();
  assert.deepEqual(s.taken, [ID]);
  assert.deepEqual(results(s.published), [{ id: "r1", ok: false, detail: "Error: stt down" }]);
});

// @spec SHARED-INJ-013
test("a missing, taken or expired upload is answered `upload expired or missing` without calling the kind", async () => {
  const s = setup({ takeUpload: async () => null });
  s.h(evt(req()));
  await s.h.drain();
  assert.deepEqual(results(s.published), [{ id: "r1", ok: false, detail: "upload expired or missing" }]);
  assert.deepEqual(s.calls, []);
});

// @spec SHARED-INJ-013
test("a Redis read that rejects is reported with the error text and the kind is not called", async () => {
  const s = setup({ takeUpload: async () => { throw new Error("redis down"); } });
  s.h(evt(req()));
  await s.h.drain();
  assert.deepEqual(results(s.published), [{ id: "r1", ok: false, detail: "Error: redis down" }]);
  assert.deepEqual(s.calls, []);
});

// @spec SHARED-INJ-006
test("an upload read not completed within readTimeoutMs is reported as a timeout", async () => {
  const s = setup({ readTimeoutMs: 30, takeUpload: () => new Promise(() => {}) });
  s.h(evt(req()));
  await s.h.drain();
  const [r] = results(s.published);
  assert.equal(r!.ok, false);
  assert.match(String(r!.detail), /timed out after 30 ms/);
  assert.deepEqual(s.calls, []);
});

// @spec SHARED-INJ-007
test("an upload over the byte cap for its kind is reported with the limit", async () => {
  const s = setup({ maxBytes: { audio: 1000 }, takeUpload: async () => Buffer.alloc(5000) });
  s.h(evt(req()));
  await s.h.drain();
  assert.deepEqual(results(s.published), [{ id: "r1", ok: false, detail: "upload larger than the 1000 byte limit" }]);
  assert.deepEqual(s.calls, []);
});

// @spec SHARED-INJ-008
test("@cohost/shared no longer exports the URL guard", async () => {
  const shared = (await import("../src/index.js")) as Record<string, unknown>;
  assert.equal("uploadUrl" in shared, false);
});

// @spec SHARED-INJ-009
test("the callback queues and returns without awaiting; requests run one at a time in arrival order", async () => {
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let active = 0, maxActive = 0;
  const s = setup({
    kinds: { text: async (r: Req) => { active++; maxActive = Math.max(maxActive, active); if (r.id === "a") await gate; order.push(r.id); active--; return { detail: r.id }; } },
  });
  const t0 = performance.now();
  const rets = ["a", "b", "c"].map((id) => s.h(evt(req({ id, kind: "text", text: "x" }))));
  assert.ok(performance.now() - t0 < 50, "did not wait for the slow request");
  assert.deepEqual(rets, [undefined, undefined, undefined]);
  release();
  await s.h.drain();
  assert.deepEqual(order, ["a", "b", "c"]);
  assert.equal(maxActive, 1);
});

// @spec SHARED-INJ-010
test("a request arriving while 8 are waiting is answered `busy` and not queued", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const ran: string[] = [];
  const s = setup({ kinds: { text: async (r: Req) => { ran.push(r.id); await gate; return {}; } } });
  for (let i = 0; i < 10; i++) s.h(evt(req({ id: `q${i}`, kind: "text", text: "x" })));
  // q0 is being processed, q1..q8 wait (8), q9 is refused.
  assert.deepEqual(results(s.published), [{ id: "q9", ok: false, detail: "busy" }]);
  release();
  await s.h.drain();
  assert.equal(ran.length, 9);
  assert.ok(!ran.includes("q9"));
});

// @spec SHARED-INJ-011
test("a kind function's result is published with the request id; a throw becomes ok false with the error text", async () => {
  const s = setup({
    kinds: {
      text: async (r: Req) => { if (r.text === "boom") throw new Error("kind exploded"); return { detail: "fine" }; },
      audio: async () => ({ ok: false, detail: "empty transcript" }),
    },
  });
  s.h(evt(req({ id: "ok", kind: "text", text: "hi" })));
  s.h(evt(req({ id: "bad", kind: "text", text: "boom" })));
  s.h(evt(req({ id: "soft" })));
  await s.h.drain();
  assert.deepEqual(results(s.published), [
    { id: "ok", ok: true, detail: "fine" },
    { id: "bad", ok: false, detail: "Error: kind exploded" },
    { id: "soft", ok: false, detail: "empty transcript" },
  ]);
});

// @spec SHARED-INJ-012
test("a failing inject.result publish is logged and the next queued request still runs", async () => {
  let n = 0;
  const published: string[] = [];
  const warns: unknown[] = [];
  const bus = { publish: async (_t: string, d: { id: string }) => { if (n++ === 0) throw new Error("bus down"); published.push(d.id); return "1"; } };
  const h = createInjectHandler({
    target: "chat", bus: bus as never, log: { warn: (o: unknown) => warns.push(o) } as never,
    kinds: { text: async () => ({}) }, maxBytes: {}, readTimeoutMs: 10,
  });
  h(evt(req({ target: "chat", id: "one", kind: "text", text: "x" })));
  h(evt(req({ target: "chat", id: "two", kind: "text", text: "x" })));
  await h.drain();
  assert.deepEqual(published, ["two"]);
  assert.ok(warns.length >= 1);
});

// @spec SHARED-INJ-009
test("subscribeInject creates the group, subscribes to inject.request with start latest, and fails fatally if the subscription rejects", async () => {
  const calls: unknown[] = [];
  let handler: unknown;
  const bus = {
    resetGroup: async (g: string) => { calls.push(["reset", g]); },
    subscribe: (o: unknown, h: unknown) => { calls.push(["subscribe", o]); handler = h; return Promise.reject(new Error("redis gone")); },
  };
  const exits: number[] = [];
  const errors: unknown[] = [];
  const h = (() => undefined) as never;
  await subscribeInject({ bus: bus as never, group: "eyes", handler: h, log: { error: (o: unknown) => errors.push(o) } as never, exit: (c) => { exits.push(c); } });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(calls, [["reset", "eyes"], ["subscribe", { group: "eyes", types: ["inject.request"], start: "latest" }]]);
  assert.equal(handler, h);
  assert.deepEqual(exits, [1]);
  assert.equal(errors.length, 1);
});
