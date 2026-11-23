import { test } from "node:test";
import assert from "node:assert/strict";
import { join_, relay, eventually, externalAddress, type Client, type Relay } from "./relay-rig.js";
import { model } from "./models-rig.js";

// Who may speak on the relay, and GET /avatar/renderer (DASH-AVR-015..019).

const report = (o: Record<string, unknown> = {}) => ({ type: "model", version: "v1", state: "ready", detail: "ok", ...o });
const pageModel = async (r: Relay, i = 0) => (await r.renderer()).pages[i]?.model;

/** Sends `msg`, waits until the server has handled it and returns the reported model of page 0. */
async function say(r: Relay, c: Client, msg: unknown): Promise<unknown> {
  c.send(msg);
  await c.barrier();
  return pageModel(r);
}

// @spec DASH-AVR-016, DASH-AVR-017
test("a loopback socket's model report is kept per page and its detail cut at 200 characters", async (t) => {
  const r = await relay(t);
  const c = await join_(r.port);
  assert.equal(await pageModel(r), null, "nothing reported yet");
  assert.deepEqual(await say(r, c, report({ state: "loading", detail: "x".repeat(300) })), { state: "loading", detail: "x".repeat(200) });
  assert.deepEqual(await say(r, c, report({ state: "failed", detail: "y".repeat(200) })), { state: "failed", detail: "y".repeat(200) });
  assert.deepEqual(await say(r, c, report({ state: "ready", detail: "" })), { state: "ready", detail: "" });
});

// @spec DASH-AVR-016
test("a message of any other shape is ignored and keeps the socket open", async (t) => {
  const r = await relay(t);
  const c = await join_(r.port);
  const kept = { state: "ready", detail: "kept" };
  assert.deepEqual(await say(r, c, report({ detail: "kept" })), kept);
  const other: unknown[] = [
    "not json", "[]", "null", "42", { type: "view", model: null }, { type: "status", state: "live", driver: null }, { type: "frame", frame: {} },
    report({ state: "bogus", detail: "bad" }), report({ state: 3, detail: "bad" }), report({ version: 7, detail: "bad" }), report({ detail: 7 }),
    { type: "model", state: "failed", detail: "bad" }, { type: "model", version: "v", detail: "bad" }, { type: "MODEL", version: "v", state: "failed", detail: "bad" },
    [report({ state: "failed", detail: "bad" })], { type: ["model"], version: "v", state: "failed", detail: "bad" },
  ];
  for (const m of other) assert.deepEqual(await say(r, c, m), kept, JSON.stringify(m));
  c.ws.send(Buffer.from(JSON.stringify(report({ state: "failed", detail: "bad" }))), { binary: true });
  await c.barrier();
  assert.deepEqual(await pageModel(r), kept, "a binary message is ignored");
  assert.equal(c.closed, false);
});

// @spec DASH-AVR-015
test("a socket not on loopback is listed only as connected with its sent rate, and every message it sends is ignored", { skip: externalAddress() ? false : "no non-loopback interface" }, async (t) => {
  const addr = externalAddress()!;
  const r = await relay(t, { lanHost: "0.0.0.0" });
  const local = await join_(r.port);
  const far = await join_(r.lanPort, { host: addr });
  assert.deepEqual(await say(r, local, report({ state: "ready", detail: "local" })), { state: "ready", detail: "local" });
  far.send(report({ state: "failed", detail: "from the LAN" }));
  far.send({ type: "view", model: null });
  await far.barrier();
  const pages = (await r.renderer()).pages as { model: unknown; sentFps: number; since: number }[];
  assert.equal(pages.length, 2);
  assert.equal(pages.filter((p) => p.model === null).length, 1, "the LAN page reports no model");
  assert.deepEqual(pages.map((p) => p.model).filter(Boolean), [{ state: "ready", detail: "local" }]);
  assert.equal(far.closed, false, "ignoring is not closing");
});

// @spec DASH-AVR-018
test("GET /avatar/renderer answers 200 no-store with exactly the documented fields", async (t) => {
  const r = await relay(t, { seed: { "Aiko.vrm": model("a") }, renderer: { model: "AIKO.vrm", zoom: 1.5, offset_y: -0.2, turn: 10 } });
  const idle = await r.get("/avatar/renderer");
  assert.equal(idle.status, 200);
  assert.equal(idle.headers["cache-control"], "no-store");
  assert.match(String(idle.headers["content-type"]), /^application\/json/);
  assert.deepEqual(Object.keys(idle.json()).sort(), ["applied", "driver", "fps", "maxPages", "maxPreviews", "pages", "previews", "state"]);
  assert.deepEqual(idle.json(), {
    state: "waiting", driver: null, fps: null,
    applied: { model: "Aiko.vrm", configuredModel: "AIKO.vrm", zoom: 1.5, offsetY: -0.2, turn: 10 },
    pages: [], previews: 0, maxPages: 4, maxPreviews: 2,
  });
  const connectedAt = r.clock.now();
  await join_(r.port);
  await join_(r.port, { preview: true });
  const s = await r.renderer();
  assert.equal(s.previews, 1);
  assert.equal(s.pages.length, 1);
  assert.deepEqual(Object.keys(s.pages[0]).sort(), ["model", "sentFps", "since"]);
  assert.equal(s.pages[0].model, null);
  assert.equal(s.pages[0].sentFps, 0);
  assert.ok(Math.abs(s.pages[0].since - connectedAt) < 5000, `since ${s.pages[0].since} is the connect time ${connectedAt}`);
});

// @spec DASH-AVR-018
test("a configured model with no stored file leaves applied.model null and configuredModel as configured", async (t) => {
  const r = await relay(t, { renderer: { model: "Gone.vrm" } });
  assert.deepEqual((await r.renderer()).applied, { model: null, configuredModel: "Gone.vrm", zoom: 1, offsetY: 0, turn: 0 });
});

// @spec DASH-AVR-018
test("GET /avatar/renderer is a 404 on the LAN listener", async (t) => {
  const r = await relay(t);
  assert.equal((await r.lan("GET", "/avatar/renderer")).status, 404);
  assert.equal((await r.lan("HEAD", "/avatar/renderer")).status, 404);
});

// @spec DASH-AVR-018, DASH-AVR-020
test("state and driver in the route are those of the status message and come from the feed's avatar.state", async (t) => {
  const r = await relay(t);
  await join_(r.port);
  r.clock.toTick();
  r.bus.state("vmc");
  r.clock.advance(1000);
  await eventually(async () => (await r.renderer()).state === "off", "off in the route");
  assert.equal((await r.renderer()).driver, "vmc");
});

// @spec DASH-AVR-019
test("fps is the frames received in the last 2 s over 2, rounded, null unless live; sentFps counts finished frame sends the same way", async (t) => {
  const r = await relay(t);
  const c = await join_(r.port);
  await r.bus.until(() => r.bus.reading);
  r.clock.toTick();
  r.clock.advance(100);
  for (let i = 0; i < 6; i++) {
    r.bus.batch({ mouthOpen: (i + 1) / 10 });
    await c.next((m) => m.type === "frame" && (m.frame as { mouthOpen: number }).mouthOpen === (i + 1) / 10);
    r.clock.advance(100);
  }
  r.clock.advance(300); // the 1 s tick at 2 s: the frames are live, 6 of them in the last 2 s
  await c.next((m) => m.type === "status" && m["state"] === "live");
  let s = await r.renderer();
  assert.equal(s.state, "live");
  assert.equal(s.fps, 3);
  assert.equal(s.pages[0].sentFps, 3);
  r.clock.advance(1_000); // 1.9 s since the first frames: still within 2 s
  r.bus.batch({ mouthOpen: 0.99 });
  await c.next((m) => m.type === "frame" && (m.frame as { mouthOpen: number }).mouthOpen === 0.99);
  s = await r.renderer();
  assert.equal(s.fps, 4, "7 frames in the window");
  r.clock.advance(2_500); // every frame is older than 2 s
  s = await r.renderer();
  assert.equal(s.fps, null, "not live");
  assert.equal(s.pages[0].sentFps, 0);
});

// @spec DASH-AVR-019
test("a page that is slower than the Engine shows a lower sentFps than the others", async (t) => {
  const r = await relay(t);
  const slow = await join_(r.port), fast = await join_(r.lanPort);
  await r.bus.until(() => r.bus.reading);
  const sock = (slow.ws as unknown as { _socket: { pause(): void } })._socket;
  sock.pause();
  r.clock.toTick();
  r.clock.advance(100);
  for (let i = 0; i < 40_000; i++) {
    r.bus.batch({ mouthOpen: (i % 100) / 100, expression: "e".repeat(64) });
    await new Promise((res) => setImmediate(res));
  }
  r.clock.advance(900);
  const s = await r.renderer();
  const rates = (s.pages as { sentFps: number }[]).map((p) => p.sentFps);
  assert.ok(Math.max(...rates) > Math.min(...rates), `sentFps differ: ${rates.join(",")}`);
  assert.equal(fast.closed, false);
});
