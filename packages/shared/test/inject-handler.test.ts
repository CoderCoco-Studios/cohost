import { test } from "node:test";
import assert from "node:assert/strict";
import type { BusEvent } from "@cohost/bus";
import { INJECT_STALE_MS, createInjectHandler, subscribeInject, uploadUrl } from "../src/index.js";

const DASH = "http://dashboard:3000";
const UP = `${DASH}/uploads/abc`;

type Req = BusEvent<"inject.request">["data"];
const req = (over: Partial<Req> = {}): Req => ({ id: "r1", target: "ears", kind: "audio", url: UP, remember: false, ...over } as Req);
const evt = (data: Req, ts = Date.now()): BusEvent<"inject.request"> => ({ id: "1", type: "inject.request", ts, source: "dashboard", data });

function setup(over: Record<string, unknown> = {}) {
  const published: { type: string; data: Record<string, unknown> }[] = [];
  const warns: unknown[] = [];
  const bus = { publish: async (type: string, data: Record<string, unknown>) => { published.push({ type, data }); return "1"; } };
  const calls: string[] = [];
  const log = { warn: (o: unknown) => warns.push(o), info() {}, error() {}, debug() {} };
  const fetched: string[] = [];
  const okFetch = async (url: string) => { fetched.push(url); return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "audio/wav" } }); };
  const h = createInjectHandler({
    target: "ears", bus: bus as never, log: log as never, dashboardUrl: DASH,
    kinds: { audio: async (bytes: Buffer) => { calls.push(`audio:${bytes.length}`); return { detail: "heard it" }; } },
    maxBytes: { audio: 1000, image: 1000 }, fetchTimeoutMs: 200, fetch: okFetch as never,
    ...over,
  } as never);
  return { h, published, warns, calls, fetched };
}
const results = (p: { type: string; data: Record<string, unknown> }[]) => p.filter((x) => x.type === "inject.result").map((x) => x.data);

// @spec SHARED-INJ-001
test("a request for another target is ignored and publishes nothing", async () => {
  const s = setup();
  s.h(evt(req({ target: "eyes" })));
  await s.h.drain();
  assert.deepEqual(s.published, []);
  assert.deepEqual(s.fetched, []);
});

// @spec SHARED-INJ-002, SHARED-INJ-008
test("a request older than INJECT_STALE_MS when it leaves the queue gets `stale`, fetching and calling nothing", async () => {
  const s = setup();
  s.h(evt(req(), Date.now() - INJECT_STALE_MS - 1000));
  await s.h.drain();
  assert.deepEqual(results(s.published), [{ id: "r1", ok: false, detail: "stale" }]);
  assert.deepEqual(s.fetched, []);
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
test("a URL off the dashboard's /uploads/ origin, or with credentials, fetches nothing", async () => {
  const s = setup();
  for (const url of ["http://evil:3000/uploads/a", `${DASH}/other/a`, "http://u:p@dashboard:3000/uploads/a", undefined]) {
    s.h(evt(req({ url })));
  }
  await s.h.drain();
  assert.equal(results(s.published).length, 4);
  for (const r of results(s.published)) assert.deepEqual(r, { id: "r1", ok: false, detail: "url is not an upload of this dashboard" });
  assert.deepEqual(s.fetched, []);
});

// @spec SHARED-INJ-008
test("uploadUrl accepts only same-origin /uploads/<id> and honours a base path", () => {
  assert.equal(uploadUrl(UP, DASH), UP);
  assert.equal(uploadUrl(`${DASH}/uploads/`, DASH), undefined);
  assert.equal(uploadUrl("http://u:p@dashboard:3000/uploads/a", DASH), undefined);
  assert.equal(uploadUrl(`${DASH}/uploads/../secret`, DASH), undefined);
  assert.equal(uploadUrl("not a url", DASH), undefined);
  assert.equal(uploadUrl(undefined, DASH), undefined);
  assert.equal(uploadUrl("http://h/dash/uploads/a", "http://h/dash/"), "http://h/dash/uploads/a");
  assert.equal(uploadUrl("http://h/uploads/a", "http://h/dash"), undefined);
});

// @spec SHARED-INJ-005
test("the fetch refuses redirects, and a redirect or non-2xx yields `fetch upload <status>` without calling the kind", async () => {
  let init: RequestInit | undefined;
  const s = setup({ fetch: async (_u: string, i: RequestInit) => { init = i; return new Response("no", { status: 503 }); } });
  s.h(evt(req()));
  await s.h.drain();
  assert.equal(init?.redirect, "error");
  assert.deepEqual(results(s.published), [{ id: "r1", ok: false, detail: "fetch upload 503" }]);
  assert.deepEqual(s.calls, []);
  const r = setup({ fetch: async () => { throw new TypeError("fetch failed: redirect"); } });
  r.h(evt(req()));
  await r.h.drain();
  assert.equal(results(r.published)[0]!.ok, false);
  assert.deepEqual(r.calls, []);
});

// @spec SHARED-INJ-006
test("an upload fetch not completed within fetchTimeoutMs is aborted and reported as a timeout", async () => {
  const s = setup({
    fetchTimeoutMs: 30,
    fetch: (_u: string, i: RequestInit) => new Promise((_res, rej) => { i.signal!.addEventListener("abort", () => rej(i.signal!.reason)); }),
  });
  s.h(evt(req()));
  await s.h.drain();
  const [r] = results(s.published);
  assert.equal(r!.ok, false);
  assert.match(String(r!.detail), /timed out after 30 ms/);
  assert.deepEqual(s.calls, []);
});

// @spec SHARED-INJ-007
test("an upload over the byte cap for its kind is not read further and is reported with the limit", async () => {
  const big = new Uint8Array(5000);
  const s = setup({ maxBytes: { audio: 1000 }, fetch: async () => new Response(big, { status: 200 }) });
  s.h(evt(req()));
  await s.h.drain();
  assert.deepEqual(results(s.published), [{ id: "r1", ok: false, detail: "upload larger than the 1000 byte limit" }]);
  assert.deepEqual(s.calls, []);
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new Uint8Array(600)); }, cancel() { cancelled = true; } });
  const t = setup({ maxBytes: { audio: 1000 }, fetch: async () => new Response(stream, { status: 200 }) });
  t.h(evt(req()));
  await t.h.drain();
  assert.equal(cancelled, true, "body reading stopped");
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
  const rets = ["a", "b", "c"].map((id) => s.h(evt(req({ id, kind: "text", url: undefined, text: "x" }))));
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
  for (let i = 0; i < 10; i++) s.h(evt(req({ id: `q${i}`, kind: "text", url: undefined, text: "x" })));
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
  s.h(evt(req({ id: "ok", kind: "text", url: undefined, text: "hi" })));
  s.h(evt(req({ id: "bad", kind: "text", url: undefined, text: "boom" })));
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
    target: "chat", bus: bus as never, log: { warn: (o: unknown) => warns.push(o) } as never, dashboardUrl: DASH,
    kinds: { text: async () => ({}) }, maxBytes: {}, fetchTimeoutMs: 10,
  });
  h(evt(req({ target: "chat", id: "one", kind: "text", url: undefined, text: "x" })));
  h(evt(req({ target: "chat", id: "two", kind: "text", url: undefined, text: "x" })));
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
