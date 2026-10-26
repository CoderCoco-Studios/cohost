import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeBus, event, silentLog } from "@cohost/testing";
import { Eyes } from "../src/eyes.js";
import { createInjectHandler, uploadUrl } from "../src/inject.js";

const DASH = "http://dashboard:3000";
const UP = `${DASH}/uploads/abc123`;

function setup(reply: string | Error = "a menu screen", over: { fetch?: typeof fetch; now?: () => number } = {}) {
  const bus = new FakeBus();
  const fetched: string[] = [];
  const described: [string, string][] = [];
  const handle = createInjectHandler({
    bus, log: silentLog, dashboardUrl: DASH,
    fetch: over.fetch ?? (async (u) => { fetched.push(String(u)); return new Response(Buffer.from("IMG")); }),
    describe: async (b64, prev) => { described.push([b64, prev]); if (reply instanceof Error) throw reply; return reply; },
    now: over.now,
  });
  return { bus, handle, fetched, described };
}
const req = (over: Record<string, unknown> = {}) =>
  event("inject.request", { id: "i1", target: "eyes", kind: "image", url: UP, remember: false, ...over });

test("image described: base64 bytes, empty previous, injected vision.summary then ok result", async () => {
  const t = setup();
  await t.handle(req());
  assert.deepEqual(t.fetched, [UP]);
  assert.deepEqual(t.described, [[Buffer.from("IMG").toString("base64"), ""]]);
  assert.deepEqual(t.bus.of("vision.summary"), [{ text: "a menu screen", changed: true, injected: true, remember: false }]);
  assert.deepEqual(t.bus.of("inject.result"), [{ id: "i1", ok: true, detail: "a menu screen" }]);
});

test("remember flag is carried", async () => {
  const t = setup();
  await t.handle(req({ remember: true }));
  assert.equal(t.bus.of("vision.summary")[0]!.remember, true);
});

test("SAME or empty reply: ok:false, no summary", async () => {
  for (const reply of ["SAME", "same.", ""]) {
    const t = setup(reply);
    await t.handle(req());
    assert.equal(t.bus.of("vision.summary").length, 0);
    assert.equal(t.bus.of("inject.result")[0]!.ok, false);
  }
});

test("model failure: ok:false with the error, no summary", async () => {
  const t = setup(new Error("vision model 503"));
  await t.handle(req());
  assert.equal(t.bus.of("vision.summary").length, 0);
  const [r] = t.bus.of("inject.result");
  assert.equal(r!.ok, false);
  assert.match(r!.detail!, /vision model 503/);
});

test("foreign URLs are never fetched", async () => {
  for (const url of ["http://evil.example/uploads/abc", "http://dashboard:3000/other/abc", `${DASH}/uploads/../secret`, "http://user@dashboard:3000/uploads/a", "file:///etc/passwd", "garbage", undefined]) {
    const t = setup();
    await t.handle(req({ url }));
    assert.deepEqual(t.fetched, [], String(url));
    assert.equal(t.described.length, 0);
    assert.equal(t.bus.of("inject.result")[0]!.ok, false, String(url));
  }
});

test("fetch failure (404): ok:false without calling the model", async () => {
  const t = setup("x", { fetch: async () => new Response("gone", { status: 404 }) });
  await t.handle(req());
  assert.equal(t.described.length, 0);
  assert.match(t.bus.of("inject.result")[0]!.detail!, /404/);
});

test("stale request: only ok:false stale; other target ignored", async () => {
  const stale = setup("x", { now: () => Date.now() + 61_000 });
  await stale.handle(req());
  assert.deepEqual(stale.bus.of("inject.result"), [{ id: "i1", ok: false, detail: "stale" }]);
  assert.equal(stale.described.length, 0);
  const other = setup();
  await other.handle(req({ target: "ears", kind: "audio" }));
  assert.equal(other.bus.published.length, 0);
});

test("injection does not disturb look()'s previous description (works with no OBS: only describe is used)", async () => {
  const bus = new FakeBus();
  const previous: string[] = [];
  const replies = ["first look", "second look"];
  const describe = async (_b: string, prev: string) => { previous.push(prev); return replies.shift() ?? "an injected frame"; };
  const eyes = new Eyes({ bus, log: silentLog, screenshot: async () => "B", describe });
  const handle = createInjectHandler({ bus, log: silentLog, dashboardUrl: DASH, describe, fetch: async () => new Response("IMG") });
  await eyes.look();
  await handle(req());
  await eyes.look();
  assert.deepEqual(previous, ["", "", "first look"]);
});

test("uploadUrl accepts only same-origin /uploads/<id>", () => {
  assert.equal(uploadUrl(UP, DASH), UP);
  assert.equal(uploadUrl(`${DASH}/uploads/`, DASH), undefined);
  assert.equal(uploadUrl("http://dashboard:3001/uploads/a", DASH), undefined);
  assert.equal(uploadUrl(UP, "http://dashboard:3000/"), UP);
});
