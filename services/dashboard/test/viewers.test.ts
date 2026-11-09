import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { FakeBus, event, recordingLog, waitFor } from "@cohost/testing";
import { createDashboardHandler } from "../src/routes.js";
import { ViewersClient, viewersTokenFromEnv } from "../src/viewers.js";

const TOKEN = "s3cret-viewers";

interface BootOpts { token?: string | null; timeoutMs?: number; control?: boolean; reply?: (req: Record<string, unknown>) => Record<string, unknown> | null }

/** A dashboard whose "memory" answers each published memory.viewers.request through `reply` (null = never answer). */
async function boot(o: BootOpts = {}) {
  const bus = new FakeBus();
  const viewers = new ViewersClient(bus, o.timeoutMs ?? 3000);
  const answer = o.reply ?? (() => ({ ok: true, data: { fine: true } }));
  const publish = bus.publish.bind(bus);
  bus.publish = (async (type: never, data: never) => {
    const id = await publish(type, data);
    if (type === "memory.viewers.request") {
      const req = data as Record<string, unknown>;
      const rep = answer(req);
      if (rep) queueMicrotask(() => viewers.onReply(event("memory.viewers.reply", { id: req.id as string, ...rep } as never)));
    }
    return id;
  }) as never;
  const rec = recordingLog();
  const token = o.token === null ? undefined : o.token ?? TOKEN;
  const control = o.control ? { token: "ctl", runtime: "t", advanced: false, controller: {} as never } : undefined;
  const server = http.createServer(createDashboardHandler({
    bus, log: rec.log, html: "x", cohostName: "Coco", voiceUrl: "http://127.0.0.1:1",
    loadPersonality: () => "p", savePersonality: () => {}, services: () => [], viewers, viewersToken: token, control,
  }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = (method: string, path: string, body?: unknown, auth: string | null = `Bearer ${TOKEN}`) =>
    fetch(`${base}${path}`, {
      method,
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      headers: auth === null ? {} : { authorization: auth },
    });
  const requests = () => bus.of("memory.viewers.request");
  return { bus, base, call, requests, rec };
}

// @spec DASH-VIEWERS-001
test("GET /viewers publishes a list request with q, and answers 200 with the reply's data", async () => {
  const t = await boot({ reply: () => ({ ok: true, data: { viewers: [{ key: "1" }] } }) });
  const r = await t.call("GET", "/viewers?q=ali");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type")!, /json/);
  assert.deepEqual(await r.json(), { viewers: [{ key: "1" }] });
  assert.deepEqual(t.requests().map(({ id, ...rest }) => (typeof id === "string" && id ? rest : null)), [{ op: "list", query: "ali" }]);
  await t.call("GET", "/viewers");
  assert.deepEqual(t.requests()[1] && { ...t.requests()[1]!, id: undefined }, { id: undefined, op: "list" });
});

// @spec DASH-VIEWERS-002
test("GET /viewers/:key publishes a get request with the URL-decoded key", async () => {
  const t = await boot();
  assert.equal((await t.call("GET", "/viewers/Al%20ice%2F2")).status, 200);
  assert.equal((t.requests()[0] as { op: string; key: string }).key, "Al ice/2");
  assert.equal((t.requests()[0] as { op: string }).op, "get");
  const bad = await t.call("GET", "/viewers/%E0%A4%A");
  assert.equal(bad.status, 404, "a malformed escape names no viewer");
  assert.equal(t.requests().length, 1);
});

// @spec DASH-VIEWERS-003
test("POST /viewers/:key/notes/:id/delete publishes delete_note with the id and the optional reason", async () => {
  const t = await boot();
  assert.equal((await t.call("POST", "/viewers/1/notes/42/delete", { reason: "too personal" })).status, 200);
  assert.equal((await t.call("POST", "/viewers/1/notes/43/delete", "")).status, 200);
  const [a, b] = t.requests() as { op: string; noteId: string; reason?: string }[];
  assert.deepEqual([a!.op, a!.noteId, a!.reason], ["delete_note", "42", "too personal"]);
  assert.deepEqual([b!.op, b!.noteId, b!.reason], ["delete_note", "43", undefined]);
  assert.equal((await t.call("POST", "/viewers/1/notes/44/delete", { reason: 5 })).status, 400, "reason must be a string");
  assert.equal(t.requests().length, 2);
});

// @spec DASH-VIEWERS-004
test("POST /viewers/deletions/:id/restore publishes restore", async () => {
  const t = await boot();
  assert.equal((await t.call("POST", "/viewers/deletions/9/restore")).status, 200);
  assert.deepEqual(t.requests().map(({ id: _id, ...rest }) => rest), [{ op: "restore", deletionId: "9" }]);
});

// @spec DASH-VIEWERS-005
test("POST /viewers/:key/clear publishes clear with the key and the optional reason", async () => {
  const t = await boot();
  assert.equal((await t.call("POST", "/viewers/Al%20ice/clear", { reason: "reset" })).status, 200);
  assert.equal((await t.call("POST", "/viewers/bob/clear", {})).status, 200);
  const [a, b] = t.requests() as { op: string; key: string; reason?: string }[];
  assert.deepEqual([a!.op, a!.key, a!.reason], ["clear", "Al ice", "reset"]);
  assert.deepEqual([b!.op, b!.key, b!.reason], ["clear", "bob", undefined]);
});

// @spec DASH-VIEWERS-006
test("POST /viewers/regular publishes set_regular for a key or a non-blank name; anything else is 400 and publishes nothing", async () => {
  const t = await boot();
  assert.equal((await t.call("POST", "/viewers/regular", { key: "k1", regular: true })).status, 200);
  assert.equal((await t.call("POST", "/viewers/regular", { name: "Pat", regular: false })).status, 200);
  const [a, b] = t.requests() as Record<string, unknown>[];
  assert.deepEqual([a!.op, a!.key, a!.name, a!.regular], ["set_regular", "k1", undefined, true]);
  assert.deepEqual([b!.op, b!.key, b!.name, b!.regular], ["set_regular", undefined, "Pat", false]);
  for (const bad of [{ regular: true }, { name: "   ", regular: true }, { key: "k", regular: "yes" }, { key: "k" }, { key: 5, regular: true }, { name: "", key: " ", regular: true }]) {
    assert.equal((await t.call("POST", "/viewers/regular", bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal(t.requests().length, 2);
});

// @spec DASH-VIEWERS-007
test("VIEWERS_TOKEN set: every /viewers route needs the bearer token, with or without control mode; nothing is published otherwise", async () => {
  for (const control of [false, true]) {
    const t = await boot({ control });
    const routes: [string, string, unknown?][] = [
      ["GET", "/viewers"], ["GET", "/viewers/k"], ["POST", "/viewers/k/notes/1/delete", {}], ["POST", "/viewers/deletions/1/restore"],
      ["POST", "/viewers/k/clear", {}], ["POST", "/viewers/regular", { name: "x", regular: true }], ["GET", "/viewers/unknown/route/shape"],
    ];
    for (const [m, p, b] of routes) {
      for (const auth of [null, "Bearer wrong", `Bearer ${TOKEN}x`, TOKEN, "Basic abc"]) {
        const r = await t.call(m!, p!, b, auth);
        assert.equal(r.status, 401, `${m} ${p} with ${auth}`);
        assert.equal(r.headers.get("www-authenticate"), "Bearer");
      }
    }
    assert.equal(t.requests().length, 0);
    assert.equal((await t.call("GET", "/viewers")).status, 200, "the right token passes, also when CONTROL_TOKEN differs");
  }
});

// @spec DASH-VIEWERS-007
test("VIEWERS_TOKEN unset or empty: every /viewers route answers 403 naming VIEWERS_TOKEN and publishes nothing", async () => {
  for (const token of [null, ""]) {
    const t = await boot({ token });
    for (const [m, p, b] of [["GET", "/viewers"], ["GET", "/viewers/k"], ["POST", "/viewers/regular", { name: "x", regular: true }]] as [string, string, unknown?][]) {
      const r = await t.call(m, p, b);
      assert.equal(r.status, 403);
      assert.match(await r.text(), /VIEWERS_TOKEN/);
    }
    assert.equal((await t.call("GET", "/viewers", undefined, null)).status, 403);
    assert.equal(t.requests().length, 0);
  }
});

// @spec DASH-VIEWERS-007, CFG-ENV-009
test("the token is read from the environment, trimmed; blank means unset", () => {
  assert.equal(viewersTokenFromEnv({ VIEWERS_TOKEN: " abc " }), "abc");
  assert.equal(viewersTokenFromEnv({ VIEWERS_TOKEN: "   " }), undefined);
  assert.equal(viewersTokenFromEnv({}), undefined);
});

// @spec DASH-VIEWERS-008
test("reply mapping: ok -> 200 data, not_found -> 404 with the detail, other errors -> 500 with the detail", async () => {
  const t = await boot({ reply: (req) => req.op === "get" ? { ok: false, error: "not_found", detail: "no viewer zed" } : req.op === "list" ? { ok: false, error: "failed", detail: "Error: db down" } : { ok: false, detail: "odd" } });
  const nf = await t.call("GET", "/viewers/zed");
  assert.equal(nf.status, 404);
  assert.equal(((await nf.json()) as { detail: string }).detail, "no viewer zed");
  const bad = await t.call("GET", "/viewers");
  assert.equal(bad.status, 500);
  assert.equal(((await bad.json()) as { detail: string }).detail, "Error: db down");
  assert.equal((await t.call("POST", "/viewers/deletions/1/restore")).status, 500, "ok:false without a known error is still a failure");
});

// @spec DASH-VIEWERS-008
test("no reply within the timeout answers 504 'memory did not answer'; a late or foreign reply is ignored", async () => {
  const t = await boot({ timeoutMs: 40, reply: () => null });
  const r = await t.call("GET", "/viewers");
  assert.equal(r.status, 504);
  assert.equal(((await r.json()) as { detail: string }).detail, "memory did not answer");
});

// @spec DASH-VIEWERS-008
test("a reply is matched to its request by id: concurrent requests each get their own answer", async () => {
  const bus = new FakeBus();
  const client = new ViewersClient(bus, 1000);
  const a = client.request({ op: "get", key: "a" });
  const b = client.request({ op: "get", key: "b" });
  await waitFor(() => bus.of("memory.viewers.request").length === 2, "both published");
  const [ra, rb] = bus.of("memory.viewers.request") as { id: string }[];
  client.onReply(event("memory.viewers.reply", { id: "unknown", ok: true, data: "stray" }));
  client.onReply(event("memory.viewers.reply", { id: rb!.id, ok: true, data: "for b" }));
  client.onReply(event("memory.viewers.reply", { id: ra!.id, ok: true, data: "for a" }));
  assert.equal((await a)!.data, "for a");
  assert.equal((await b)!.data, "for b");
});

// @spec DASH-VIEWERS-009
test("a POST body over 64 KiB is 413 and one that is not a JSON object is 400, publishing nothing; an empty body is {}", async () => {
  const t = await boot();
  assert.equal((await t.call("POST", "/viewers/regular", "x".repeat(65 * 1024))).status, 413);
  assert.equal((await t.call("POST", "/viewers/k/clear", "{nope")).status, 400);
  assert.equal((await t.call("POST", "/viewers/k/clear", "[1]")).status, 400);
  assert.equal((await t.call("POST", "/viewers/k/clear", "null")).status, 400);
  assert.equal((await t.call("POST", "/viewers/k/clear", "7")).status, 400);
  assert.equal(t.requests().length, 0);
  assert.equal((await t.call("POST", "/viewers/k/clear", "")).status, 200);
  assert.equal(t.requests().length, 1);
});

// @spec DASH-VIEWERS-008
test("an unknown /viewers path or method is 404 after authorization and publishes nothing; a publish failure is 500 and leaves nothing pending", async () => {
  const t = await boot();
  assert.equal((await t.call("DELETE", "/viewers/k")).status, 404);
  assert.equal((await t.call("GET", "/viewers/a/b/c/d/e")).status, 404);
  assert.equal(t.requests().length, 0);
  t.bus.fail = (type) => type === "memory.viewers.request";
  assert.equal((await t.call("GET", "/viewers")).status, 500);
});

// @spec DASH-VIEWERS-001
test("the viewers routes are not on the page or the ws feed: GET / and /health are unaffected and need no token", async () => {
  const t = await boot();
  assert.equal((await t.call("GET", "/", undefined, null)).status, 200);
  assert.equal((await t.call("GET", "/health", undefined, null)).status, 200);
});
