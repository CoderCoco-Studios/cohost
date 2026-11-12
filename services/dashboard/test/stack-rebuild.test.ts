import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { FakeBus, recordingLog } from "@cohost/testing";
import { HealthTracker, SERVICE_MANIFEST, withContainerRestarts, type StackResult, type StackStatus } from "@cohost/control";
import { createDashboardHandler } from "../src/routes.js";
import { setupControl } from "../src/control.js";
import { createFeed, type FeedSocket } from "../src/feed.js";
import { StackService, type StackOps } from "../src/stack.js";

const tick = () => new Promise<void>((r) => setImmediate(r));
const restarter = { restart: async () => ({ ok: true }) };

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
test("POST /stack/rebuild needs the token, answers 202 {ok, action: rebuild} and is 404 with control disabled", async () => {
  const rec = recordingLog();
  const svc = new StackService({ log: rec.log, bus: () => "connected" });
  const f = ops(crashed);
  svc.attach(f.o);
  await svc.probe();
  const setup = setupControl({ CONTROL_ENABLED: "1", CONTROL_TOKEN: "s3cret" }, new FakeBus(), rec.log, { name: "compose", start: async () => ({ ok: true }), stop: async () => ({ ok: true }), restart: async () => ({ ok: true }) });
  const mk = (control: typeof setup.control) => http.createServer(createDashboardHandler({
    bus: new FakeBus(), log: rec.log, html: "x", cohostName: "Coco", voiceUrl: "http://127.0.0.1:1",
    loadPersonality: () => "p", savePersonality: () => {}, services: () => [], ...(control ? { control } : {}), stack: svc,
  }));
  const on = mk(setup.control);
  const off = mk(undefined as never);
  for (const s of [on, off]) await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  after(() => { on.close(); off.close(); });
  const url = (s: http.Server, p: string) => `http://127.0.0.1:${(s.address() as { port: number }).port}${p}`;
  assert.equal((await fetch(url(off, "/stack/rebuild"), { method: "POST" })).status, 404);
  assert.equal((await fetch(url(on, "/stack/rebuild"), { method: "POST" })).status, 401);
  const r = await fetch(url(on, "/stack/rebuild"), { method: "POST", headers: { authorization: "Bearer s3cret" } });
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

// @spec DASH-HTTP-014
test("GET /services/manifest lists every unit of the manifest, ungated, and carries no argv material", async () => {
  const rec = recordingLog();
  const setup = setupControl({ CONTROL_ENABLED: "1", CONTROL_TOKEN: "s3cret" }, new FakeBus(), rec.log, { name: "compose", start: async () => ({ ok: true }), stop: async () => ({ ok: true }), restart: async () => ({ ok: true }) });
  const server = http.createServer(createDashboardHandler({
    bus: new FakeBus(), log: rec.log, html: "x", cohostName: "Coco", voiceUrl: "http://127.0.0.1:1",
    loadPersonality: () => "p", savePersonality: () => {}, services: () => [], control: setup.control, stack: new StackService({ log: rec.log, bus: () => "connected" }),
  }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  after(() => server.close());
  const r = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/services/manifest`);
  assert.equal(r.status, 200);
  const body = (await r.json()) as { units: { id: string; requires: string[]; infra: boolean; defaultMode: string }[] };
  assert.deepEqual(body.units.map((u) => u.id), SERVICE_MANIFEST.map((s) => s.id));
  assert.deepEqual(body.units.find((u) => u.id === "cortex")!.requires, ["salience", "affect"]);
  assert.equal(body.units.find((u) => u.id === "redis")!.infra, true);
  assert.doesNotMatch(JSON.stringify(body), /pnpm|composeName|isolatedEnv/);
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
