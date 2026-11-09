import { test } from "node:test";
import assert from "node:assert/strict";
import { HealthTracker } from "@cohost/control";
import type { BusEvent } from "@cohost/bus";
import { event, waitFor } from "@cohost/testing";
import { createFeed, serveClient, startFeed, type FeedSocket } from "../src/feed.js";
import { dashboardHealth } from "../src/health.js";
import { runHeartbeat } from "@cohost/testing";

const hb = (over: Record<string, unknown> = {}) => ({
  service: "chat", instance: "i", pid: 1, version: "0", startedAt: 1, state: "ready" as const,
  deps: {}, mode: "live", intervalMs: 5000, ...over,
});

class Sock implements FeedSocket {
  readyState = 1;
  sent: { type: string; id?: string; replay?: boolean; services?: { service: string; state: string }[] }[] = [];
  closed = false;
  send(d: string) { this.sent.push(JSON.parse(d)); }
  close() { this.closed = true; }
  services() { return this.sent.filter((m) => m.type === "services"); }
}

function setup(clock = { t: 1_000_000 }, extra: { onViewersReply?: (ev: BusEvent<"memory.viewers.reply">) => void } = {}) {
  const tracker = new HealthTracker({ now: () => clock.t });
  const socks = new Set<Sock>();
  let tailHandler: (ev: BusEvent) => void = () => {};
  let healthHandler: (h: never) => void = () => {};
  let healthFrom = "";
  const recentEvents: BusEvent[] = [];
  let gate: Promise<void> = Promise.resolve();
  let replayError: Error | undefined;
  const recentHeartbeats: { id: string; ts: number; data: ReturnType<typeof hb> }[] = [];
  const bus = {
    recent: async (): Promise<BusEvent[]> => { await gate; if (replayError) throw replayError; return recentEvents; },
    tail: async (h: (ev: BusEvent) => void) => { tailHandler = h; },
    recentHealth: async () => recentHeartbeats as never,
    tailHealth: async (h: never, from: string) => { healthHandler = h; healthFrom = from; },
  };
  const feed = createFeed({ bus, tracker, clients: () => socks, tickMs: 20, ...extra });
  return { clock, tracker, socks, feed, recentEvents,
    failReplay: (e: Error | undefined) => { replayError = e; },
    holdReplay: () => { let open!: () => void; gate = new Promise<void>((r) => { open = r; }); return open; }, recentHeartbeats, healthFrom: () => healthFrom,
    emit: (ev: BusEvent) => tailHandler(ev), beat: (d: ReturnType<typeof hb>) => healthHandler({ data: d } as never) };
}

// @spec DASH-FEED-001
test("a new client gets the services snapshot on connect", async () => {
  const t = setup();
  const ws = new Sock();
  await t.feed.onConnection(ws);
  assert.equal(ws.services().length, 1);
  assert.equal(ws.services()[0]!.services!.length, 10);
});

// @spec DASH-FEED-003
test("seeds the tracker from recent heartbeats and tails the health stream after the last one", async () => {
  const t = setup();
  t.recentHeartbeats.push({ id: "5-0", ts: t.clock.t - 1000, data: hb() });
  await t.feed.start();
  assert.equal(t.tracker.get("chat").state, "up");
  assert.equal(t.healthFrom(), "5-0");
  t.feed.stop();
});

// @spec DASH-FEED-004
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

// @spec DASH-FEED-005
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

// @spec DASH-FEED-001, DASH-FEED-002
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

// @spec DASH-FEED-007, DASH-FEED-001, DASH-FEED-002
test("viewer-notes events never reach /ws: not in the connect replay, not live, not while a replay is held", async () => {
  const t = setup();
  const ws = new Sock(); t.socks.add(ws);
  const notes = () => [
    event("memory.notes.request", { id: "n", users: ["bob"] }),
    event("memory.notes.reply", { id: "n", viewers: [{ user: "Bob", regular: true, msgCount: 9, notes: [{ layer: "core", category: "health", hint: "gently", strength: 1 }] }] }),
    { ...event("brain.status", { state: "idle" }), type: "memory.viewers.request" } as unknown as BusEvent,
    { ...event("brain.status", { state: "idle" }), type: "memory.viewers.reply" } as unknown as BusEvent,
  ];
  t.recentEvents.push(...notes(), event("brain.status", { state: "idle" }));
  await t.feed.start();
  await t.feed.onConnection(ws);
  assert.deepEqual(ws.sent.filter((m) => m.type !== "services").map((m) => m.type), ["brain.status"]);
  ws.sent.length = 0;
  for (const n of notes()) t.emit(n);
  t.emit(event("memory.recall.reply", { id: "r", memories: [] }));
  assert.deepEqual(ws.sent.map((m) => m.type), ["memory.recall.reply"], "other memory events still flow");
  const release = t.holdReplay();
  const late = new Sock(); t.socks.add(late);
  const done = t.feed.onConnection(late);
  for (const n of notes()) t.emit(n);
  release();
  await done;
  assert.deepEqual(late.sent.filter((m) => m.type !== "services").map((m) => m.type), ["brain.status"]);
  t.feed.stop();
});

const ev = (id: string, type: "brain.status" | "voice.utterance" = "brain.status"): BusEvent =>
  ({ ...event("brain.status", { state: "idle" }), id, type }) as BusEvent;

// @spec DASH-FEED-001
test("replayed events carry a replay marker; live events do not", async () => {
  const t = setup();
  const ws = new Sock(); t.socks.add(ws);
  t.recentEvents.push(ev("1-0"), ev("2-0", "voice.utterance"));
  await t.feed.start();
  await t.feed.onConnection(ws);
  const replayed = ws.sent.filter((m) => m.type !== "services");
  assert.deepEqual(replayed.map((m) => [m.id, m.replay]), [["1-0", true], ["2-0", true]]);
  ws.sent.length = 0;
  t.emit(ev("3-0"));
  assert.deepEqual(ws.sent.map((m) => [m.id, m.replay]), [["3-0", undefined]]);
  t.feed.stop();
});

// @spec DASH-FEED-001
test("a live event that lands while the replay is read reaches the client once, after the replay", async () => {
  const t = setup();
  const old = new Sock(); t.socks.add(old);
  t.recentEvents.push(ev("1-0"), ev("2-0"));
  await t.feed.start();
  const release = t.holdReplay();
  const ws = new Sock(); t.socks.add(ws); // joins the client set before the replay is read, as in ws
  const done = t.feed.onConnection(ws);
  t.emit(ev("2-0")); // already inside the replay read
  t.emit(ev("3-0")); // newer than the replay
  assert.deepEqual(ws.sent.map((m) => m.type), ["services"]); // nothing ahead of the replay
  assert.deepEqual(old.sent.map((m) => m.id), ["2-0", "3-0"]); // other clients are not held back
  release();
  await done;
  assert.deepEqual(ws.sent.filter((m) => m.type !== "services").map((m) => [m.id, !!m.replay]), [["1-0", true], ["2-0", true], ["3-0", false]]);
  ws.sent.length = 0;
  t.emit(ev("4-0"));
  assert.deepEqual(ws.sent.map((m) => m.id), ["4-0"]);
  t.feed.stop();
});

// @spec DASH-HTTP-012
test("feed.start() rejecting is logged at fatal and exits non-zero", async () => {
  const lines: [string, string][] = [];
  const log = { error: (_o: unknown, m: string) => lines.push(["error", m]), fatal: (_o: unknown, m: string) => lines.push(["fatal", m]) };
  const codes: number[] = [];
  await startFeed({ start: async () => { throw new Error("ECONNREFUSED"); } }, log, (c) => { codes.push(c); });
  assert.deepEqual(lines.map((l) => l[0]), ["fatal"]);
  assert.deepEqual(codes, [1]);
  await startFeed({ start: async () => {} }, log, (c) => { codes.push(c); });
  assert.deepEqual(codes, [1]);
});

// @spec DASH-HTTP-012
test("a failed connect replay is logged and closes that socket only; later clients are served", async () => {
  const t = setup();
  const lines: [string, string][] = [];
  const log = { error: (_o: unknown, m: string) => lines.push(["error", m]), fatal: (_o: unknown, m: string) => lines.push(["fatal", m]) };
  const bad = new Sock(), good = new Sock(); t.socks.add(bad); t.socks.add(good);
  t.recentEvents.push(ev("1-0"));
  await t.feed.start();
  t.failReplay(new Error("redis went away"));
  await serveClient(t.feed, bad, log);
  assert.equal(bad.closed, true);
  assert.deepEqual(lines.map((l) => l[0]), ["error"]);
  t.failReplay(undefined);
  await serveClient(t.feed, good, log);
  assert.equal(good.closed, false);
  assert.deepEqual(lines.map((l) => l[0]), ["error"]);
  assert.deepEqual(good.sent.filter((m) => m.type !== "services").map((m) => m.id), ["1-0"]);
  t.emit(ev("2-0"));
  assert.equal(good.sent.at(-1)!.id, "2-0");
  t.feed.stop();
});

// @spec DASH-HEALTH-001
test("dashboard heartbeat: no deps, live, ready then one stopping", async () => {
  const hbs = await runHeartbeat(dashboardHealth);
  assert.deepEqual(hbs.map((h) => h.state), ["starting", "ready", "stopping"]);
  assert.equal(hbs[1]!.service, "dashboard");
  assert.equal(hbs[1]!.mode, "live");
  assert.deepEqual(hbs[1]!.deps, {});
});

// @spec DASH-FEED-007, DASH-FEED-001, DASH-FEED-002
test("viewer-notes events never reach a /ws client, neither live nor in the connect replay, and viewers replies go to the Viewers client instead", async () => {
  const replies: string[] = [];
  const t = setup(undefined, { onViewersReply: (e) => replies.push(e.id) });
  const ws = new Sock(); t.socks.add(ws);
  const secret = [
    // The notes events are catalogued with the surfacing change; the feed filters them by name regardless.
    { type: "memory.notes.request", ts: 1, source: "cortex", data: { id: "n1", users: ["a"] } },
    { type: "memory.notes.reply", ts: 1, source: "memory", data: { id: "n1", viewers: [] } },
    event("memory.viewers.request", { id: "v1", op: "list" }),
    event("memory.viewers.reply", { id: "v1", ok: true, data: { viewers: [{ note: "health" }] } }),
  ] as unknown as BusEvent[];
  secret.forEach((e, i) => { (e as { id: string }).id = `${i + 1}-0`; });
  t.recentEvents.push(...secret, ev("9-0"));
  await t.feed.onConnection(ws);
  assert.deepEqual(ws.sent.filter((m) => m.type !== "services").map((m) => m.type), ["brain.status"]);
  await t.feed.start();
  ws.sent.length = 0;
  for (const e of secret) t.emit(e);
  t.emit(ev("10-0"));
  assert.deepEqual(ws.sent.map((m) => m.id), ["10-0"]);
  assert.deepEqual(replies, ["4-0"], "only the reply goes to the Viewers client");
  t.feed.stop();
});
