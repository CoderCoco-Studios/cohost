import { test } from "node:test";
import assert from "node:assert/strict";
import { HealthTracker } from "@cohost/control";
import type { BusEvent } from "@cohost/bus";
import { event, waitFor } from "@cohost/testing";
import { createFeed, type FeedSocket } from "../src/feed.js";
import { dashboardHealth } from "../src/health.js";
import { runHeartbeat } from "@cohost/testing";

const hb = (over: Record<string, unknown> = {}) => ({
  service: "chat", instance: "i", pid: 1, version: "0", startedAt: 1, state: "ready" as const,
  deps: {}, mode: "live", intervalMs: 5000, ...over,
});

class Sock implements FeedSocket {
  readyState = 1;
  sent: { type: string; services?: { service: string; state: string }[] }[] = [];
  send(d: string) { this.sent.push(JSON.parse(d)); }
  services() { return this.sent.filter((m) => m.type === "services"); }
}

function setup(clock = { t: 1_000_000 }) {
  const tracker = new HealthTracker({ now: () => clock.t });
  const socks = new Set<Sock>();
  let tailHandler: (ev: BusEvent) => void = () => {};
  let healthHandler: (h: never) => void = () => {};
  let healthFrom = "";
  const recentEvents: BusEvent[] = [];
  const recentHeartbeats: { id: string; ts: number; data: ReturnType<typeof hb> }[] = [];
  const bus = {
    recent: async () => recentEvents,
    tail: async (h: (ev: BusEvent) => void) => { tailHandler = h; },
    recentHealth: async () => recentHeartbeats as never,
    tailHealth: async (h: never, from: string) => { healthHandler = h; healthFrom = from; },
  };
  const feed = createFeed({ bus, tracker, clients: () => socks, tickMs: 20 });
  return { clock, tracker, socks, feed, recentEvents, recentHeartbeats, healthFrom: () => healthFrom,
    emit: (ev: BusEvent) => tailHandler(ev), beat: (d: ReturnType<typeof hb>) => healthHandler({ data: d } as never) };
}

test("a new client gets the services snapshot on connect", async () => {
  const t = setup();
  const ws = new Sock();
  await t.feed.onConnection(ws);
  assert.equal(ws.services().length, 1);
  assert.equal(ws.services()[0]!.services!.length, 10);
});

test("seeds the tracker from recent heartbeats and tails the health stream after the last one", async () => {
  const t = setup();
  t.recentHeartbeats.push({ id: "5-0", ts: t.clock.t - 1000, data: hb() });
  await t.feed.start();
  assert.equal(t.tracker.get("chat").state, "up");
  assert.equal(t.healthFrom(), "5-0");
  t.feed.stop();
});

test("pushes services when a state changes, not for identical heartbeats", async () => {
  const t = setup();
  const ws = new Sock(); t.socks.add(ws);
  await t.feed.start();
  t.beat(hb()); t.beat(hb());
  assert.equal(ws.services().length, 1);
  t.beat(hb({ deps: { twitch: "down" } }));
  assert.equal(ws.services().length, 2);
  assert.equal(ws.services()[1]!.services!.find((s) => s.service === "chat")!.state, "degraded");
  t.feed.stop();
});

test("the 1 s tick pushes staleness transitions", async () => {
  const t = setup();
  const ws = new Sock(); t.socks.add(ws);
  await t.feed.start();
  t.beat(hb());
  assert.equal(ws.services().length, 1);
  t.clock.t += 16_000;
  await waitFor(() => ws.services().length === 2, "stale push");
  assert.equal(ws.services()[1]!.services!.find((s) => s.service === "chat")!.state, "stale");
  t.feed.stop();
});

test("heartbeats never reach the event feed or the connect replay; other events do", async () => {
  const t = setup();
  const ws = new Sock(); t.socks.add(ws);
  t.recentEvents.push(
    event("brain.status", { state: "idle" }),
    { ...event("control", { cmd: "mute" }), type: "service.heartbeat" as never },
  );
  await t.feed.onConnection(ws);
  assert.deepEqual(ws.sent.filter((m) => m.type !== "services").map((m) => m.type), ["brain.status"]);
  await t.feed.start();
  ws.sent.length = 0;
  t.emit({ ...event("control", { cmd: "mute" }), type: "service.heartbeat" as never });
  t.emit(event("brain.status", { state: "thinking" }));
  assert.deepEqual(ws.sent.map((m) => m.type), ["brain.status"]);
  t.feed.stop();
});

test("dashboard heartbeat: no deps, live, ready then one stopping", async () => {
  const hbs = await runHeartbeat(dashboardHealth);
  assert.deepEqual(hbs.map((h) => h.state), ["starting", "ready", "stopping"]);
  assert.equal(hbs[1]!.service, "dashboard");
  assert.equal(hbs[1]!.mode, "live");
  assert.deepEqual(hbs[1]!.deps, {});
});
