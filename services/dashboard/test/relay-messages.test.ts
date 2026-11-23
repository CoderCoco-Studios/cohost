import { test } from "node:test";
import assert from "node:assert/strict";
import { connect, join_, relay, frame, eventually, type Client, type Relay } from "./relay-rig.js";
import { model, send } from "./models-rig.js";

// What the relay sends and when: the connect pair, the message shapes, the state rules, the reader, the newest-only batch,
// the per-socket slots and the view pushes (DASH-AVR-005..014, 021). Time is the fake clock; synchronisation is the
// receive of a later message from the same socket or a ping round trip, never a wait on wall time.

type Msg = Record<string, unknown> & { type: string };
const statuses = (ms: Msg[]): Msg[] => ms.filter((m) => m.type === "status");

let zoomSeq = 1;
/** Pushes two `view`s (two applied-view changes) and returns everything that arrived before the second one: a status or frame
 *  that was waiting when the first was sent has been sent by then, whichever order the slots go in. */
async function quiesce(r: Relay, c: Client): Promise<Msg[]> {
  const seen: Msg[] = [];
  for (let i = 0; i < 2; i++) {
    const z = 1.5 + 0.01 * zoomSeq++;
    await r.zoom(z);
    const v = await c.next((m) => m.type === "view" && (m.framing as { zoom: number }).zoom === z, seen);
    assert.equal(v.type, "view");
  }
  return seen;
}

/** Waits for the next status message of `c`. */
const nextStatus = (c: Client): Promise<Msg> => c.next((m) => m.type === "status");

// @spec DASH-AVR-005
test("a connecting socket gets view then status and no replayed frame; frames arriving afterwards reach it", async (t) => {
  const r = await relay(t);
  const a = await join_(r.port);
  await r.bus.until(() => r.bus.reading);
  r.bus.batch({ mouthOpen: 0.1 });
  assert.equal((await a.next((m) => m.type === "frame")).type, "frame");
  const upgrade = await connect(r.lanPort);
  assert.equal(upgrade.result, "open");
  if (upgrade.result !== "open") return;
  const b = upgrade.client;
  const first = await b.next(), second = await b.next();
  assert.deepEqual([first.type, second.type], ["view", "status"]);
  r.bus.batch({ mouthOpen: 0.7 });
  const f = await b.next((m) => m.type === "frame");
  assert.equal((f.frame as { mouthOpen: number }).mouthOpen, 0.7, "the first frame is the one after connect, not the earlier one");
});

// @spec DASH-AVR-006, DASH-AVR-007
test("view and status have exactly the documented shapes, with model null when nothing is applied", async (t) => {
  const r = await relay(t, { renderer: { zoom: 1.25, offset_y: -0.1, turn: 15 } });
  const c = await join_(r.port);
  c.msgs.length = 0;
  const u = await connect(r.lanPort);
  assert.equal(u.result, "open");
  if (u.result !== "open") return;
  const { view, status } = await u.client.hello();
  assert.deepEqual(view, { type: "view", model: null, framing: { zoom: 1.25, offsetY: -0.1, turn: 15 } });
  assert.deepEqual(status, { type: "status", state: "waiting", driver: null });
});

// @spec DASH-AVR-006
test("view.model holds the version equal to the etag without W/ and quotes; a preview also holds the name and a page never does", async (t) => {
  const r = await relay(t, { seed: { "Aiko.vrm": model("a") }, renderer: { model: "Aiko.vrm" } });
  const etag = (await r.get("/avatar/model")).headers["etag"] as string;
  const version = etag.replace(/^W\//, "").replace(/^"|"$/g, "");
  const page = await connect(r.port), lan = await connect(r.lanPort, { preview: true }), preview = await connect(r.port, { preview: true });
  assert.ok(page.result === "open" && lan.result === "open" && preview.result === "open");
  if (page.result !== "open" || lan.result !== "open" || preview.result !== "open") return;
  assert.deepEqual((await page.client.hello()).view["model"], { version });
  assert.deepEqual((await lan.client.hello()).view["model"], { version }, "preview=1 on the LAN listener is a page: no file name");
  assert.deepEqual((await preview.client.hello()).view["model"], { version, name: "Aiko.vrm" });
});

// @spec DASH-AVR-008, DASH-AVR-007
test("state is live while a frame arrived in the last second, otherwise waiting without a recent non-browser driver", async (t) => {
  const r = await relay(t);
  const c = await join_(r.port);
  await r.bus.until(() => r.bus.reading);
  r.clock.toTick();
  r.clock.advance(300);
  r.bus.batch({ mouthOpen: 0.2 });
  r.clock.advance(700); // the next tick: the frame is 0.7 s old
  assert.deepEqual(await nextStatus(c), { type: "status", state: "live", driver: null });
  r.clock.advance(1000); // the frame is 1.7 s old
  assert.deepEqual(await nextStatus(c), { type: "status", state: "waiting", driver: null });
});

// @spec DASH-AVR-008
test("state is off while the latest avatar.state names a driver other than browser and was received within 3 s; the event's own ts does not count", async (t) => {
  const r = await relay(t);
  const c = await join_(r.port);
  r.clock.toTick();
  r.bus.state("vmc", 1); // a ts decades old: only the receive time counts
  r.clock.advance(1000);
  assert.deepEqual(await nextStatus(c), { type: "status", state: "off", driver: "vmc" });
  r.clock.advance(1000);
  r.clock.advance(1000);
  r.clock.advance(1000); // received 3.x s ago: past the limit at the tick after 3 s
  assert.deepEqual(await nextStatus(c), { type: "status", state: "waiting", driver: null });
  r.bus.state("vmc", Date.now() + 86_400_000); // a ts in the future is no fresher
  r.clock.advance(1000);
  assert.deepEqual(await nextStatus(c), { type: "status", state: "off", driver: "vmc" });
});

// @spec DASH-AVR-008
test("a browser driver is never off: the state is waiting and names the driver while avatar.state is recent", async (t) => {
  const r = await relay(t);
  const c = await join_(r.port);
  r.clock.toTick();
  r.bus.state("browser");
  r.clock.advance(1000);
  assert.deepEqual(await nextStatus(c), { type: "status", state: "waiting", driver: "browser" });
});

// @spec DASH-AVR-008
test("a frame wins over a non-browser driver: live names that driver", async (t) => {
  const r = await relay(t);
  const c = await join_(r.port);
  await r.bus.until(() => r.bus.reading);
  r.clock.toTick();
  r.bus.state("vmc");
  r.clock.advance(300);
  r.bus.batch({});
  r.clock.advance(700);
  assert.deepEqual(await c.next((m) => m.type === "status" && m["state"] === "live"), { type: "status", state: "live", driver: "vmc" });
});

// @spec DASH-AVR-009
test("a status goes to every socket when state or driver changes and to none while neither does", async (t) => {
  const r = await relay(t);
  const a = await join_(r.port), b = await join_(r.lanPort);
  r.clock.toTick();
  r.bus.state("vmc");
  r.clock.advance(1000);
  for (const c of [a, b]) assert.deepEqual(await nextStatus(c), { type: "status", state: "off", driver: "vmc" });
  r.bus.state("vmc"); // renewed, unchanged
  for (let i = 0; i < 5; i++) { r.clock.advance(1000); r.bus.state("vmc"); }
  for (const c of [a, b]) assert.deepEqual(statuses(await quiesce(r, c)), [], "five ticks with no change sent no status");
  r.bus.state("other"); // the driver changes while the state stays off
  r.clock.advance(1000);
  for (const c of [a, b]) assert.deepEqual(await nextStatus(c), { type: "status", state: "off", driver: "other" });
});

// @spec DASH-AVR-010
test("a frame message holds exactly the fields of the newest frame", async (t) => {
  const r = await relay(t);
  const c = await join_(r.port);
  await r.bus.until(() => r.bus.reading);
  const f = frame({ mouthOpen: 0.5, headY: -12.5, emotion: "happy", intensity: 0.6, expression: "wink" });
  r.bus.batch(f);
  assert.deepEqual(await c.next((m) => m.type === "frame"), { type: "frame", frame: f });
});

// @spec DASH-AVR-012
test("of several frames delivered in one batch only the newest is sent", async (t) => {
  const r = await relay(t);
  const c = await join_(r.port);
  await r.bus.until(() => r.bus.reading);
  r.bus.batch({ mouthOpen: 0.1 }, { mouthOpen: 0.2 }, { mouthOpen: 0.3 });
  await new Promise((res) => setImmediate(res)); // a separate batch
  r.bus.batch({ mouthOpen: 0.9 });
  const got: number[] = [];
  while (got.at(-1) !== 0.9) got.push(((await c.next((m) => m.type === "frame")).frame as { mouthOpen: number }).mouthOpen);
  assert.deepEqual(got, [0.3, 0.9]);
});

// @spec DASH-AVR-011, DASH-AVR-020
test("one reader runs while any socket is open, starts with the first and stops with the last, and the feed's tail is the only read of the event stream", async (t) => {
  const r = await relay(t);
  assert.equal(r.bus.starts, 0, "nobody is watching: no read");
  const a = await join_(r.port);
  await r.bus.until(() => r.bus.starts === 1);
  const b = await join_(r.lanPort);
  assert.equal(r.bus.starts, 1, "a second socket shares the reader");
  await a.close();
  await eventually(async () => (await r.renderer()).pages.length === 1, "the first close seen");
  assert.equal(r.bus.stops, 0, "one socket is still open");
  await b.close();
  await r.bus.until(() => r.bus.stops === 1);
  assert.equal(r.bus.reading, false);
  await join_(r.port);
  await r.bus.until(() => r.bus.starts === 2);
  assert.equal(r.bus.tails, 1, "the relay opens no read of its own on the event stream");
  assert.equal(r.bus.recents, 0);
});

// @spec DASH-AVR-014
test("while the reader delivers nothing the state is never live, and the relay leaves the retry to the bus client", async (t) => {
  const r = await relay(t);
  const c = await join_(r.port);
  await r.bus.until(() => r.bus.reading);
  r.bus.state("vmc");
  for (let i = 0; i < 30; i++) { r.clock.advance(1000); if (i % 5 === 4) await c.barrier(); }
  const states = statuses(c.drain()).map((m) => m["state"]);
  assert.ok(states.length > 0 && !states.includes("live"), `states ${states.join(",")}`);
  assert.deepEqual([r.bus.starts, r.bus.stops], [1, 0], "no restart and no stop by the relay");
});

// @spec DASH-AVR-021
test("every change of the applied view pushes a view to every open socket, a preview's with the model name", async (t) => {
  const r = await relay(t, { seed: { "Aiko.vrm": model("a"), "Bea.vrm": model("b") }, renderer: { model: "Aiko.vrm" } });
  const a = await join_(r.port), b = await join_(r.lanPort), p = await join_(r.port, { preview: true });
  const versionOf = async () => ((await r.get("/avatar/model")).headers["etag"] as string).replace(/^W\//, "").replace(/^"|"$/g, "");
  const first = await versionOf();
  assert.equal((await r.save({ model: "Bea.vrm", zoom: 2, turn: 30 })).status, 200);
  const second = await versionOf();
  assert.notEqual(first, second);
  for (const c of [a, b]) assert.deepEqual(await c.next((m) => m.type === "view"), { type: "view", model: { version: second }, framing: { zoom: 2, offsetY: 0, turn: 30 } });
  assert.deepEqual((await p.next((m) => m.type === "view"))["model"], { version: second, name: "Bea.vrm" });
  // Replacing the applied model's file gives it a new version, and that is a change too.
  const up = await send(r.port, "POST", "/avatar/models?name=Bea.vrm&replace=1", { headers: r.auth, body: model("bb", 256) });
  assert.equal(up.status, 201, up.text);
  const third = await versionOf();
  assert.notEqual(third, second);
  for (const c of [a, b, p]) assert.equal(((await c.next((m) => m.type === "view"))["model"] as { version: string }).version, third);
});

// @spec DASH-AVR-013
test("a socket that cannot keep up gets the newest frame and, ahead of it, the newest view and status", async (t) => {
  const r = await relay(t);
  const c = await join_(r.port);
  const other = await join_(r.lanPort);
  await r.bus.until(() => r.bus.reading);
  const sock = (c.ws as unknown as { _socket: { pause(): void; resume(): void } })._socket;
  r.clock.toTick();
  r.clock.advance(300); // the frames below are 0.3 s past a tick, so the state tick that follows is not at a window edge
  sock.pause(); // the client stops reading: once its buffers fill, a send does not finish
  for (let i = 0; i < 40_000; i++) {
    r.bus.batch({ mouthOpen: (i % 100) / 100, expression: "e".repeat(64) });
    await new Promise((res) => setImmediate(res));
  }
  r.clock.advance(700); // the tick: the frames are live
  r.bus.state("vmc");
  r.clock.advance(1000); // the frames are 1.7 s old: a changed status while the send is blocked
  await r.zoom(3.25); // a changed view while it is blocked
  r.bus.batch({ headX: 42 }); // the newest frame
  await other.next((m) => m.type === "frame" && (m.frame as { headX: number }).headX === 42);
  sock.resume();
  const seen: Msg[] = [];
  await c.next((m) => m.type === "frame" && (m.frame as { headX: number }).headX === 42, seen);
  const frames = seen.filter((m) => m.type === "frame").length;
  assert.ok(frames < 40_000, `a slow socket skipped frames (${frames} of 40000 arrived), nothing queued`);
  const lastView = seen.findLastIndex((m) => m.type === "view"), lastStatus = seen.findLastIndex((m) => m.type === "status");
  assert.ok(lastView >= 0 && lastStatus >= 0, "view and status were sent before the newest frame");
  assert.equal((seen[lastView]!["framing"] as { zoom: number }).zoom, 3.25);
  assert.equal(seen[lastStatus]!["driver"], "vmc");
});

// @spec DASH-AVR-013
test("a socket whose send has not finished in 5 s is terminated; one that is merely slow for less is kept", async (t) => {
  const r = await relay(t);
  const c = await join_(r.port);
  const ok = await join_(r.lanPort);
  await r.bus.until(() => r.bus.reading);
  const sock = (c.ws as unknown as { _socket: { pause(): void } })._socket;
  sock.pause();
  for (let i = 0; i < 40_000; i++) {
    r.bus.batch({ mouthOpen: (i % 100) / 100, expression: "e".repeat(64) });
    await new Promise((res) => setImmediate(res));
  }
  r.clock.advance(4_000);
  assert.equal((await r.renderer()).pages.length, 2, "not terminated at 4 s");
  r.clock.advance(1_500);
  await eventually(async () => (await r.renderer()).pages.length === 1, "the stuck socket terminated");
  assert.equal(ok.closed, false, "the other socket is untouched");
});
