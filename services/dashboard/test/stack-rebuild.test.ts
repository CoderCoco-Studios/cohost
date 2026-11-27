import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { FakeBus, recordingLog } from "@cohost/testing";
import { HealthTracker, SERVICE_MANIFEST, unitDescriptors, withContainerRestarts, type StackResult, type StackStatus } from "@cohost/control";
import { createDashboardHandler } from "../src/routes.js";
import { setupControl } from "../src/control.js";
import { createFeed, type FeedSocket } from "../src/feed.js";
import { StackService, type StackOps } from "../src/stack.js";
import { AUTH, TEST_GATE, UNUSED_STORE, testControl } from "./control-fixture.js";

const url = (s: http.Server, p: string) => `http://127.0.0.1:${(s.address() as { port: number }).port}${p}`;
const tick = () => new Promise<void>((r) => setImmediate(r));
const restarter = { restart: async () => ({ ok: true }) };
/** A FakeBus the control plane can reset consumer groups on. */
class CtlBus extends FakeBus { async resetGroup(): Promise<void> {} }

/** A StackOps that records calls; `statusWithRestarts` is the one the probe should prefer. */
function ops(withRestarts: StackStatus) {
  const calls: string[] = [];
  let release: (r: StackResult) => void = () => {};
  const hold = () => new Promise<StackResult>((r) => { release = r; });
  const o: StackOps = {
    status: async () => { calls.push("status"); return { docker: { ok: true }, services: [] }; },
    statusWithRestarts: async () => { calls.push("statusWithRestarts"); return withRestarts; },
    launch: async () => { calls.push("launch"); return hold(); },
    rebuild: async () => { calls.push("rebuild"); return hold(); },
    stopAll: async () => { calls.push("stop"); return hold(); },
    restartAll: async () => { calls.push("restart"); return hold(); },
    consolidate: async () => { calls.push("consolidate"); return { ok: true }; },
  };
  return { o, calls, finish: (r: StackResult) => release(r) };
}

const crashed: StackStatus = { docker: { ok: true }, services: [{ service: "redis", status: "running", health: "healthy", restartCount: 0 }, { service: "cortex", status: "restarting", restartCount: 6 }] };

// @spec DASH-STACK-008
test("a rebuild request runs the rebuild action; the stack reads as starting while it runs, then the slot is free", async () => {
  const rec = recordingLog();
  const svc = new StackService({ log: rec.log, bus: () => "connected" });
  const f = ops(crashed);
  svc.attach(f.o);
  await svc.probe();
  assert.deepEqual(svc.request("rebuild", restarter), { ok: true, action: "rebuild" });
  assert.equal(svc.snapshot().action!.kind, "rebuild");
  assert.equal(svc.snapshot().state, "starting");
  svc.hooks.onPhase("rebuild", "waiting");
  assert.equal(svc.snapshot().action!.phase, "waiting");
  assert.deepEqual(f.calls.filter((c) => c === "rebuild" || c === "launch"), ["rebuild"]);
  f.finish({ ok: true });
  await tick(); await tick();
  assert.equal(svc.snapshot().action, null);
  assert.equal(svc.snapshot().last?.kind, "rebuild");
  assert.equal(svc.request("launch", restarter).ok, true, "the slot is free again");
});

// @spec DASH-STACK-008
test("POST /stack/rebuild passes the gate (401 without the token) and answers 202 {ok, action: rebuild}", async () => {
  const rec = recordingLog();
  const svc = new StackService({ log: rec.log, bus: () => "connected" });
  const f = ops(crashed);
  svc.attach(f.o);
  await svc.probe();
  const setup = setupControl({}, new CtlBus(), rec.log, TEST_GATE, { name: "compose", start: async () => ({ ok: true }), stop: async () => ({ ok: true }), restart: async () => ({ ok: true }) });
  const on = http.createServer(createDashboardHandler({
    bus: new FakeBus(), log: rec.log, cohostName: "Coco", voiceUrl: "http://127.0.0.1:1",
    store: UNUSED_STORE, services: () => [], control: setup.control, stack: svc,
  }));
  await new Promise<void>((r) => on.listen(0, "127.0.0.1", r));
  after(() => { on.close(); });
  assert.equal((await fetch(url(on, "/stack/rebuild"), { method: "POST" })).status, 401);
  const r = await fetch(url(on, "/stack/rebuild"), { method: "POST", headers: AUTH });
  assert.equal(r.status, 202);
  assert.deepEqual(await r.json(), { ok: true, action: "rebuild" });
  assert.ok(f.calls.includes("rebuild"));
});

// @spec DASH-STACK-007, DASH-FEED-010
test("the probe reads container restart counts, and the snapshot carries them per container", async () => {
  const svc = new StackService({ log: recordingLog().log, bus: () => "connected" });
  const f = ops(crashed);
  svc.attach(f.o);
  await svc.probe();
  assert.deepEqual(f.calls, ["statusWithRestarts"]);
  assert.deepEqual(svc.snapshot().services.map((c) => [c.service, c.restartCount]), [["cortex", 6], ["redis", 0]]);
});

// @spec DASH-STACK-010
test("the snapshot carries each container's isolation overrides as `overrides`: empty for none, absent where the probe could not read them; GET /stack serves them", async () => {
  const status: StackStatus = {
    docker: { ok: true },
    services: [
      { service: "avatar", status: "running", restartCount: 0, overrides: { AVATAR_DRIVER: "null" } },
      { service: "cortex", status: "running", restartCount: 0, overrides: {} },
      { service: "redis", status: "running", health: "healthy" },
    ],
  };
  const rec = recordingLog();
  const svc = new StackService({ log: rec.log, bus: () => "connected" });
  svc.attach(ops(status).o);
  await svc.probe();
  const snap = svc.snapshot();
  const of = (name: string) => snap.services.find((c) => c.service === name)!;
  assert.deepEqual(of("avatar").overrides, { AVATAR_DRIVER: "null" });
  assert.deepEqual(of("cortex").overrides, {});
  assert.equal("overrides" in of("redis"), false);
  const server = http.createServer(createDashboardHandler({
    bus: new FakeBus(), log: rec.log, cohostName: "Coco", voiceUrl: "http://127.0.0.1:1",
    store: UNUSED_STORE, services: () => [], stack: svc, control: testControl(),
  }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  after(() => server.close());
  const body = (await (await fetch(url(server, "/stack"))).json()) as { services: { service: string; overrides?: unknown }[] };
  assert.deepEqual(body.services.map((c) => [c.service, c.overrides]), [["avatar", { AVATAR_DRIVER: "null" }], ["cortex", {}], ["redis", undefined]]);
});

// @spec DASH-HTTP-014, MOD-MAN-007
test("GET /services/manifest lists every unit of the manifest, ungated, and carries no argv material", async () => {
  const rec = recordingLog();
  const setup = setupControl({}, new CtlBus(), rec.log, TEST_GATE, { name: "compose", start: async () => ({ ok: true }), stop: async () => ({ ok: true }), restart: async () => ({ ok: true }) });
  const server = http.createServer(createDashboardHandler({
    bus: new FakeBus(), log: rec.log, cohostName: "Coco", voiceUrl: "http://127.0.0.1:1",
    store: UNUSED_STORE, services: () => [], control: setup.control, stack: new StackService({ log: rec.log, bus: () => "connected" }),
  }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  after(() => server.close());
  const r = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/services/manifest`);
  assert.equal(r.status, 200);
  const body = (await r.json()) as { units: { id: string; requires: string[]; infra: boolean; defaultMode: string }[] };
  assert.deepEqual(body.units.map((u) => u.id), SERVICE_MANIFEST.map((s) => s.id));
  assert.deepEqual(body.units.find((u) => u.id === "cortex")!.requires, ["salience", "affect"]);
  assert.equal(body.units.find((u) => u.id === "redis")!.infra, true);
  assert.deepEqual(body.units, JSON.parse(JSON.stringify(unitDescriptors())), "each unit carries id, config, uses, requires, pause, test, infra and defaultMode");
  assert.deepEqual(Object.keys(body.units[0]!).toSorted(), ["config", "defaultMode", "id", "infra", "pause", "requires", "test", "uses"]);
  assert.doesNotMatch(JSON.stringify(body), /pnpm|composeName|isolatedEnv/);
});

// @spec DASH-HTTP-014
test("GET /services/manifest lists the twenty units in manifest order, the tools service and the discord connector among them, each with the eight members and no compose name, pnpm filter or environment preset", async () => {
  const rec = recordingLog();
  const server = http.createServer(createDashboardHandler({
    bus: new FakeBus(), log: rec.log, cohostName: "Coco", voiceUrl: "http://127.0.0.1:1",
    store: UNUSED_STORE, services: () => [], stack: new StackService({ log: rec.log, bus: () => "connected" }), control: testControl(),
  }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  after(() => server.close());
  const r = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/services/manifest`);
  assert.equal(r.status, 200, "ungated: no token and no control mode");
  const { units } = (await r.json()) as { units: Record<string, unknown>[] };
  assert.equal(units.length, 20);
  assert.deepEqual(units.map((u) => u.id), SERVICE_MANIFEST.map((s) => s.id));
  for (const id of ["tools", "connector-discord", "stt-nemotron", "stt-kyutai", "tts-pocket"]) assert.ok(units.some((u) => u.id === id), id);
  for (const u of units) {
    assert.deepEqual(Object.keys(u).toSorted(), ["config", "defaultMode", "id", "infra", "pause", "requires", "test", "uses"], String(u.id));
    assert.deepEqual(Object.keys(u.test as object).toSorted(), ["inputs", "observe"], String(u.id));
  }
  const tools = units.find((u) => u.id === "tools")!;
  assert.deepEqual((tools.test as { inputs: string[] }).inputs, ["text"]);
  assert.doesNotMatch(JSON.stringify(units), /pnpm|composeName|isolatedEnv|TOOLS_MODE/);
});

class Sock implements FeedSocket {
  readyState = 1;
  sent: Record<string, unknown>[] = [];
  send(d: string) { this.sent.push(JSON.parse(d)); }
  close() {}
}

// @spec DASH-FEED-010
test("services snapshots are sent through the decorate overlay, and again whenever the stack snapshot changes", async () => {
  const tracker = new HealthTracker();
  let status: StackStatus = { docker: { ok: true }, services: [] };
  const listeners = new Set<(s: object) => void>();
  const sock = new Sock();
  const feed = createFeed({
    bus: { recent: async () => [], tail: async () => {}, recentHealth: async () => [], tailHealth: async () => {} } as never,
    tracker,
    decorate: (snap) => withContainerRestarts(snap, status),
    clients: () => [sock],
    stack: { snapshot: () => ({ docker: status.docker }), onChange: (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; } },
  });
  await feed.onConnection(sock);
  const services = (m: Record<string, unknown>) => (m.services as { service: string; state: string }[]).find((s) => s.service === "cortex")!;
  assert.equal(services(sock.sent.find((m) => m.type === "services")!).state, "unknown");
  status = { docker: { ok: true }, services: [{ service: "cortex", status: "restarting", restartCount: 4 }] };
  for (const l of listeners) l({});
  const last = sock.sent.filter((m) => m.type === "services").at(-1)!;
  assert.equal(services(last).state, "crash-looping");
  feed.stop();
});
