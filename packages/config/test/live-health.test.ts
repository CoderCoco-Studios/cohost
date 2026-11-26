import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { repoRoot } from "./helpers/docs-fixture.ts";

// The component's behaviour lives in docs/.vitepress/theme/live-health.mjs, a plain module with no Vue import; fetch, the
// timers and the document come in as arguments, so it runs here under stubs with no browser.
const lh: any = await import(pathToFileURL(join(repoRoot, "docs/.vitepress/theme/live-health.mjs")).href);

const NOTE = "Live data shows here when you open these docs from your dashboard.";
const LIVE = "Live from your dashboard.";
const STALE = "Not updating: the dashboard is not answering.";

const goodBody = (services: unknown[] = [{ service: "cortex", state: "up" }]) => ({ services });
const answer = (body: unknown, o: { status?: number; type?: string | null } = {}) => ({
  status: o.status ?? 200,
  headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? (o.type === undefined ? "application/json; charset=utf-8" : o.type) : null) },
  json: async () => {
    if (body instanceof Error) throw body;
    return body;
  },
});

interface Pending { url: string; init: any; resolve: (r: any) => void; reject: (e: unknown) => void }
function rig() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void; ms: number }>();
  const pending: Pending[] = [];
  const views: { status: string; rows: any[] | null }[] = [];
  const listeners = new Set<() => void>();
  const doc = {
    visibilityState: "visible",
    addEventListener: (t: string, f: () => void) => { if (t === "visibilitychange") listeners.add(f); },
    removeEventListener: (t: string, f: () => void) => { if (t === "visibilitychange") listeners.delete(f); },
  };
  const fetchStub = (url: string, init: any) =>
    new Promise((resolve, reject) => {
      const p = { url, init, resolve, reject };
      pending.push(p);
      init?.signal?.addEventListener?.("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });
  const c = lh.createLiveHealth({
    fetch: fetchStub,
    setTimeout: (fn: () => void, ms: number) => { const id = nextId++; timers.set(id, { at: now + ms, fn, ms }); return id; },
    clearTimeout: (id: number) => { timers.delete(id); },
    document: doc,
    onChange: (v: any) => views.push({ status: v.status, rows: v.rows }),
  });
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  const advance = async (ms: number) => {
    const to = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= to).toSorted((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      now = due[1].at;
      timers.delete(due[0]);
      due[1].fn();
      await flush();
    }
    now = to;
    await flush();
  };
  const reply = async (r: any) => { pending.shift()!.resolve(r); await flush(); };
  const fail = async () => { pending.shift()!.reject(new TypeError("network")); await flush(); };
  const setVisible = async (v: "visible" | "hidden") => { doc.visibilityState = v; for (const f of [...listeners]) f(); await flush(); };
  return { c, pending, views, timers, listeners, advance, reply, fail, setVisible, flush, doc, last: () => views.at(-1) };
}

// @spec DOCS-LIVE-005
test("an answer is valid only with status 200, a JSON content type and services of {service, state} strings", () => {
  const ok = (a: any) => lh.isValidAnswer(a);
  assert.equal(ok({ status: 200, contentType: "application/json", body: goodBody() }), true);
  assert.equal(ok({ status: 200, contentType: "Application/JSON; charset=utf-8", body: goodBody([]) }), true);
  assert.equal(ok({ status: 404, contentType: "application/json", body: goodBody() }), false);
  assert.equal(ok({ status: 200, contentType: "text/html", body: goodBody() }), false);
  assert.equal(ok({ status: 200, contentType: null, body: goodBody() }), false);
  assert.equal(ok({ status: 200, contentType: "text/plain; application/json", body: goodBody() }), false);
  for (const body of [null, 5, "x", [], {}, { services: {} }, { services: "x" }, { services: [null] }, { services: [5] }, { services: [{ service: "a" }] }, { services: [{ state: "up" }] }, { services: [{ service: 1, state: "up" }] }, { services: [{ service: "a", state: 2 }] }, { services: [{ service: "a", state: "up" }, "x"] }]) {
    assert.equal(ok({ status: 200, contentType: "application/json", body }), false, JSON.stringify(body));
  }
});

// @spec DOCS-LIVE-008
test("rowTexts gives the cell texts for a full service", () => {
  const r = lh.rowTexts({ service: "cortex", state: "degraded", heartbeat: { mode: "live" }, lastSeenAgeMs: 12999, restarts: 2, needs: [{ service: "memory", state: "down" }, { service: "eyes", state: "stale" }] });
  assert.equal(r.service, "cortex");
  assert.equal(r.state, "degraded");
  assert.equal(r.needs, "needs memory (down), needs eyes (stale)");
  assert.equal(r.mode, "live");
  assert.equal(r.lastHeartbeat, "12 s ago");
  assert.equal(r.restarts, "2");
});

// @spec DOCS-LIVE-008
test("rowTexts falls back for missing or mistyped values and ignores malformed needs", () => {
  const bare = lh.rowTexts({ service: "eyes", state: "unknown" });
  assert.deepEqual({ ...bare }, { service: "eyes", state: "unknown", needs: "", mode: "—", lastHeartbeat: "never", restarts: "—" });
  const odd = lh.rowTexts({ service: "a", state: "up", heartbeat: { mode: 3 }, lastSeenAgeMs: "5", restarts: "x", needs: [{ service: "b" }, null, "x", { service: "c", state: "down" }] });
  assert.equal(odd.mode, "—");
  assert.equal(odd.lastHeartbeat, "never");
  assert.equal(odd.restarts, "—");
  assert.equal(odd.needs, "needs c (down)");
  assert.equal(lh.rowTexts({ service: "a", state: "up", heartbeat: null, needs: "nope" }).needs, "");
  assert.equal(lh.rowTexts({ service: "a", state: "up", lastSeenAgeMs: 0, restarts: 0 }).lastHeartbeat, "0 s ago");
  assert.equal(lh.rowTexts({ service: "a", state: "up", lastSeenAgeMs: 0, restarts: 0 }).restarts, "0");
});

// @spec DOCS-LIVE-008
test("rowTexts passes markup through as text, unchanged", () => {
  const r = lh.rowTexts({ service: "<b>x</b>", state: "<img src=x onerror=1>" });
  assert.equal(r.service, "<b>x</b>");
  assert.equal(r.state, "<img src=x onerror=1>");
});

// @spec DOCS-LIVE-008
test("the caption and the column headers are the specified texts", () => {
  assert.equal(lh.CAPTION, "Your services right now, from your dashboard");
  assert.deepEqual([...lh.COLUMNS], ["Service", "State", "Mode", "Last heartbeat", "Restarts"]);
});

// @spec DOCS-LIVE-003
test("the note is the first status", () => {
  assert.equal(lh.NOTE, NOTE);
  assert.equal(lh.LIVE_TEXT, LIVE);
  assert.equal(lh.STALE_TEXT, STALE);
});

// @spec DOCS-LIVE-004
test("the request is a GET of the root-relative /services, no-store, accept json, no credentials option", async () => {
  const t = rig();
  t.c.start();
  await t.flush();
  assert.equal(t.pending.length, 1);
  const p = t.pending[0]!;
  assert.equal(p.url, "/services");
  assert.equal(p.init.method ?? "GET", "GET");
  assert.equal(p.init.cache, "no-store");
  assert.equal(new Headers(p.init.headers).get("accept"), "application/json");
  assert.equal("credentials" in p.init, false);
  assert.ok(p.init.signal);
  t.c.stop();
});

// @spec DOCS-LIVE-004
test("a request with no answer after 4000 ms is aborted and counts as failed", async () => {
  const t = rig();
  t.c.start();
  await t.flush();
  await t.advance(3999);
  assert.equal(t.pending[0]!.init.signal.aborted, false);
  await t.advance(1);
  assert.equal(t.pending[0]!.init.signal.aborted, true);
  // first request failed: nothing more is ever sent
  t.pending.length = 0;
  await t.advance(60000);
  assert.equal(t.pending.length, 0);
  assert.equal(t.last(), undefined);
});

// @spec DOCS-LIVE-005
test("a request with a body that does not parse, or a wrong answer, is a failed request, thrown nowhere", async () => {
  for (const bad of [answer(new SyntaxError("x")), answer(goodBody(), { status: 404 }), answer(goodBody(), { type: "text/html" }), answer({ services: 3 }), { status: 200, headers: { get: () => { throw new Error("boom"); } }, json: async () => goodBody() }]) {
    const t = rig();
    t.c.start();
    await t.flush();
    await t.reply(bad);
    await t.advance(30000);
    assert.equal(t.pending.length, 0, "no further request after a failed first request");
    assert.equal(t.views.length, 0);
  }
});

// @spec DOCS-LIVE-005
test("an error raised by the view callback is caught, not thrown", async () => {
  let n = 0;
  const c = lh.createLiveHealth({
    fetch: async () => answer(goodBody()),
    setTimeout: () => 1,
    clearTimeout: () => {},
    document: { visibilityState: "visible", addEventListener() {}, removeEventListener() {} },
    onChange: () => { n++; throw new Error("render failed"); },
  });
  c.start();
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.ok(n >= 1);
  c.stop();
});

// @spec DOCS-LIVE-006
test("after a failed first request no request is sent and the visibility listener is removed", async () => {
  const t = rig();
  t.c.start();
  await t.flush();
  await t.fail();
  assert.equal(t.listeners.size, 0);
  await t.setVisible("hidden");
  await t.setVisible("visible");
  await t.advance(60000);
  assert.equal(t.pending.length, 0);
});

// @spec DOCS-LIVE-007
test("a first request waits for the document to become visible", async () => {
  const t = rig();
  t.doc.visibilityState = "hidden";
  t.c.start();
  await t.flush();
  assert.equal(t.pending.length, 0);
  await t.advance(20000);
  assert.equal(t.pending.length, 0);
  await t.setVisible("visible");
  assert.equal(t.pending.length, 1);
  t.c.stop();
});

// @spec DOCS-LIVE-007, DOCS-LIVE-009
test("after a valid answer the next request goes out 5000 ms after the previous one finished", async () => {
  const t = rig();
  t.c.start();
  await t.flush();
  await t.advance(2000); // the request takes 2 s
  await t.reply(answer(goodBody()));
  assert.deepEqual(t.last(), { status: LIVE, rows: [lh.rowTexts({ service: "cortex", state: "up" })] });
  await t.advance(4999);
  assert.equal(t.pending.length, 0);
  await t.advance(1);
  assert.equal(t.pending.length, 1);
  t.c.stop();
});

// @spec DOCS-LIVE-007
test("only one request is in flight; none is sent while hidden; one goes out at once on becoming visible", async () => {
  const t = rig();
  t.c.start();
  await t.flush();
  await t.reply(answer(goodBody()));
  await t.setVisible("hidden");
  await t.advance(30000);
  assert.equal(t.pending.length, 0);
  await t.setVisible("visible");
  assert.equal(t.pending.length, 1);
  await t.setVisible("hidden");
  await t.setVisible("visible");
  assert.equal(t.pending.length, 1, "no second request while one is in flight");
  await t.reply(answer(goodBody()));
  await t.advance(5000);
  assert.equal(t.pending.length, 1);
  t.c.stop();
});

// @spec DOCS-LIVE-007
test("a request that finishes while the document is hidden schedules nothing until it is visible", async () => {
  const t = rig();
  t.c.start();
  await t.flush();
  await t.reply(answer(goodBody()));
  await t.advance(5000);
  assert.equal(t.pending.length, 1);
  await t.setVisible("hidden");
  await t.reply(answer(goodBody()));
  await t.advance(30000);
  assert.equal(t.pending.length, 0);
  await t.setVisible("visible");
  assert.equal(t.pending.length, 1);
  t.c.stop();
});

// @spec DOCS-LIVE-007
test("stop aborts a request in flight, clears the timer and the listener, and sends nothing more", async () => {
  const t = rig();
  t.c.start();
  await t.flush();
  await t.reply(answer(goodBody()));
  await t.advance(5000);
  const p = t.pending[0]!;
  t.c.stop();
  assert.equal(p.init.signal.aborted, true);
  assert.equal(t.listeners.size, 0);
  assert.equal(t.timers.size, 0);
  const viewsBefore = t.views.length;
  t.pending.length = 0;
  await t.advance(60000);
  assert.equal(t.pending.length, 0);
  assert.equal(t.views.length, viewsBefore);
});

// @spec DOCS-LIVE-007
test("start after stop does nothing special: a stopped controller stays stopped", async () => {
  const t = rig();
  t.c.start();
  t.c.stop();
  await t.flush();
  await t.setVisible("hidden");
  await t.setVisible("visible");
  assert.equal(t.pending.filter((p) => !p.init.signal.aborted).length, 0);
});

// @spec DOCS-LIVE-008
test("each valid answer replaces the rows, in the answer's order", async () => {
  const t = rig();
  t.c.start();
  await t.flush();
  await t.reply(answer(goodBody([{ service: "b", state: "up" }, { service: "a", state: "down" }])));
  assert.deepEqual(t.last()!.rows!.map((r: any) => r.service), ["b", "a"]);
  await t.advance(5000);
  await t.reply(answer(goodBody([{ service: "z", state: "stale" }])));
  assert.deepEqual(t.last()!.rows!.map((r: any) => r.service), ["z"]);
});

// @spec DOCS-LIVE-009
test("a failure after a valid answer keeps the last table, says Not updating, and keeps polling; recovery says Live again", async () => {
  const t = rig();
  t.c.start();
  await t.flush();
  await t.reply(answer(goodBody()));
  const rows = t.last()!.rows;
  await t.advance(5000);
  await t.fail();
  assert.equal(t.last()!.status, STALE);
  assert.deepEqual(t.last()!.rows, rows);
  await t.advance(5000);
  assert.equal(t.pending.length, 1, "keeps polling on the schedule");
  await t.fail();
  await t.advance(5000);
  await t.reply(answer(goodBody([{ service: "n", state: "up" }])));
  assert.equal(t.last()!.status, LIVE);
  assert.deepEqual(t.last()!.rows!.map((r: any) => r.service), ["n"]);
  t.c.stop();
});

// @spec DOCS-LIVE-010
test("the status text changes only when the condition changes", async () => {
  const t = rig();
  t.c.start();
  await t.flush();
  for (let i = 0; i < 3; i++) {
    await t.reply(answer(goodBody()));
    await t.advance(5000);
  }
  const live = t.views.filter((v) => v.status === LIVE);
  assert.equal(live.length, t.views.length, "every refresh carries the same status");
  await t.fail();
  await t.advance(5000);
  await t.fail();
  assert.equal(t.views.filter((v) => v.status === STALE).length >= 1, true);
  t.c.stop();
});
