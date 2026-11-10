import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { FakeBus, recordingLog } from "@cohost/testing";
import type { Runtime, StackResult, StackStatus } from "@cohost/control";
import { createDashboardHandler } from "../src/routes.js";
import { setupControl } from "../src/control.js";
import { StackService, type StackOps, type StackSnapshot } from "../src/stack.js";

const up = (extra: StackStatus["services"] = []): StackStatus => ({
  docker: { ok: true },
  services: [{ service: "redis", status: "running", health: "healthy" }, { service: "cortex", status: "running" }, ...extra],
});
const none: StackStatus = { docker: { ok: true }, services: [] };
const noDocker: StackStatus = { docker: { ok: false, detail: "docker: command not found" }, services: [] };

/** A StackOps whose status and long actions the test controls. */
function fakeOps(initial: StackStatus = none) {
  const calls: string[] = [];
  let status = initial;
  let release: (r: StackResult) => void = () => {};
  const hold = () => new Promise<StackResult>((r) => { release = r; });
  let restarter: unknown;
  const ops: StackOps = {
    status: async () => { calls.push("status"); return status; },
    launch: async () => { calls.push("launch"); return hold(); },
    stopAll: async () => { calls.push("stop"); return hold(); },
    restartAll: async (c) => { calls.push("restart"); restarter = c; return hold(); },
    consolidate: async () => { calls.push("consolidate"); return hold(); },
  };
  return { ops, calls, setStatus: (s: StackStatus) => { status = s; }, finish: (r: StackResult) => release(r), get restarter() { return restarter; } };
}

function service(o: { bus?: "connected" | "unreachable"; now?: () => number } = {}) {
  const rec = recordingLog();
  const bus = { v: o.bus ?? "connected" as "connected" | "unreachable" };
  const svc = new StackService({ log: rec.log, bus: () => bus.v, ...(o.now ? { now: o.now } : {}) });
  const f = fakeOps();
  svc.attach(f.ops);
  return { svc, f, rec, bus };
}
const restarter = { restart: async () => ({ ok: true }) };
const tick = () => new Promise<void>((r) => setImmediate(r));

// @spec DASH-STACK-001
test("before any probe the snapshot says Docker is unavailable and nothing has run", () => {
  const { svc } = service();
  const s = svc.snapshot();
  assert.equal(s.state, "docker-unavailable");
  assert.equal(s.docker.ok, false);
  assert.match(s.docker.detail ?? "", /not been probed/);
  assert.deepEqual([s.bus, s.action, s.last, s.services], ["connected", null, null, []]);
});

// @spec DASH-STACK-001
test("after a probe the snapshot carries the derived state, container status and health (no exit codes), sorted by service", async () => {
  const { svc, f } = service({ bus: "unreachable" });
  f.setStatus({ docker: { ok: true }, services: [{ service: "voice", status: "exited", exitCode: 1 }, { service: "cortex", status: "running", health: "healthy" }] });
  await svc.probe();
  const s = svc.snapshot();
  assert.equal(s.state, "degraded"); // voice is long-running and exited
  assert.equal(s.bus, "unreachable");
  assert.deepEqual(s.services, [{ service: "cortex", status: "running", health: "healthy" }, { service: "voice", status: "exited" }]);
});

// @spec DASH-STACK-007
test("the probe runs at startup and every 5000 ms, and never two at once", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { svc, f } = service();
  let gate!: () => void;
  const slow = new Promise<void>((r) => { gate = r; });
  const real = f.ops.status;
  f.ops.status = async () => { await slow; return real(); };
  svc.start();
  assert.equal(f.calls.length, 0); // the first probe is in flight, parked on the gate
  t.mock.timers.tick(5000); // a tick while a probe is in flight starts nothing
  t.mock.timers.tick(5000);
  gate(); await tick();
  assert.equal(f.calls.filter((c) => c === "status").length, 1);
  t.mock.timers.tick(5000); await tick();
  assert.equal(f.calls.filter((c) => c === "status").length, 2);
  svc.stop();
  t.mock.timers.tick(20_000); await tick();
  assert.equal(f.calls.filter((c) => c === "status").length, 2);
});

// @spec DASH-STACK-007
test("a phase change of a running action triggers a probe; the launch readiness wait suppresses the timer probe and its statuses are used instead", async () => {
  const { svc, f } = service();
  await svc.probe();
  f.calls.length = 0;
  f.setStatus(up());
  assert.equal(svc.request("launch", restarter).ok, true);
  svc.hooks.onPhase("launch", "compose-up");
  await tick();
  assert.deepEqual(f.calls, ["launch", "status"]); // the phase change probed
  f.calls.length = 0;
  svc.hooks.onPhase("launch", "waiting");
  await svc.probe(); // the 5 s tick: skipped during the wait
  assert.deepEqual(f.calls, []);
  svc.hooks.observe({ docker: { ok: true }, services: [{ service: "cortex", status: "running", health: "starting" }] });
  assert.deepEqual(svc.snapshot().services, [{ service: "cortex", status: "running", health: "starting" }]); // the wait's status is the current one
  f.finish({ ok: true });
  await tick(); await tick();
  f.calls.length = 0;
  await svc.probe(); // the wait is over: probing resumes
  assert.deepEqual(f.calls, ["status"]);
});

// @spec DASH-STACK-007
test("status calls made through the exclusive hook never overlap", async () => {
  const { svc } = service();
  let active = 0, max = 0;
  const job = () => svc.hooks.exclusive(async () => { active++; max = Math.max(max, active); await tick(); active--; });
  await Promise.all([job(), job(), job()]);
  assert.equal(max, 1);
});

// @spec DASH-STACK-003
test("a stack request while another action runs is refused 409 busy: <kind>", async () => {
  const { svc, f } = service();
  f.setStatus(up()); await svc.probe();
  assert.deepEqual(svc.request("launch", restarter), { ok: true, action: "launch" });
  assert.deepEqual(svc.request("stop", restarter), { ok: false, status: 409, detail: "busy: launch" });
  assert.deepEqual(svc.request("launch", restarter), { ok: false, status: 409, detail: "busy: launch" });
  assert.equal(f.calls.filter((c) => c === "launch").length, 1);
});

// @spec DASH-STACK-003
test("a lifecycle request holds the same slot: stack requests see busy, and a second lifecycle request is refused", async () => {
  const { svc, f } = service();
  f.setStatus(up()); await svc.probe();
  const release = svc.tryAcquire("service-restart");
  assert.ok(typeof release === "function");
  assert.equal(svc.tryAcquire("service-stop"), undefined);
  assert.deepEqual(svc.request("stop", restarter), { ok: false, status: 409, detail: "busy: service-restart" });
  assert.equal(svc.snapshot().action, null); // not a stack action: the page keeps its buttons
  release!();
  assert.equal(svc.request("stop", restarter).ok, true);
  assert.equal(svc.tryAcquire("service-start"), undefined); // a stack action holds it now
});

// @spec DASH-STACK-004
test("no probe yet, or Docker unavailable: 503 with the probe's detail and nothing runs", async () => {
  const { svc, f } = service();
  const first = svc.request("launch", restarter);
  assert.equal(first.ok, false);
  assert.equal((first as { status: number }).status, 503);
  f.setStatus(noDocker); await svc.probe();
  assert.deepEqual(svc.request("launch", restarter), { ok: false, status: 503, detail: "docker: command not found" });
  assert.deepEqual(f.calls.filter((c) => c !== "status"), []);
});

// @spec DASH-STACK-005
test("restart while the stack is down and consolidate while memory runs are 409; the reasons are named", async () => {
  const { svc, f } = service();
  f.setStatus(none); await svc.probe();
  const r = svc.request("restart", restarter);
  assert.equal((r as { status: number }).status, 409);
  assert.match((r as { detail: string }).detail, /down/);
  f.setStatus(up([{ service: "memory", status: "running" }])); await svc.probe();
  const c = svc.request("consolidate", restarter);
  assert.equal((c as { status: number }).status, 409);
  assert.match((c as { detail: string }).detail, /memory/);
  f.setStatus(up([{ service: "memory", status: "exited" }])); await svc.probe();
  assert.equal(svc.request("consolidate", restarter).ok, true);
  assert.deepEqual(f.calls.filter((c) => c !== "status"), ["consolidate"]);
});

// @spec DASH-STACK-002, DASH-STACK-006
test("an accepted action runs in the background with its kind as the action; restart-all gets the service controller", async () => {
  const { svc, f } = service({ now: () => 5 });
  f.setStatus(up()); await svc.probe();
  const r = svc.request("restart", restarter);
  assert.deepEqual(r, { ok: true, action: "restart" });
  assert.deepEqual(svc.snapshot().action, { kind: "restart", phase: "starting", startedAt: 5 });
  svc.hooks.onPhase("restart", "restarting cortex");
  assert.equal(svc.snapshot().action!.phase, "restarting cortex");
  assert.equal(svc.snapshot().state, "up"); // restart-all is not starting/stopping
  assert.equal(f.restarter, restarter);
  f.finish({ ok: true });
  await tick();
  assert.equal(svc.snapshot().action, null);
});

// @spec DASH-STACK-006
test("a finished action frees the slot, sets last with only the not-ready services, logs at info when ok and warn otherwise", async () => {
  const { svc, f, rec } = service({ now: () => 99 });
  f.setStatus(up()); await svc.probe();
  svc.request("launch", restarter);
  f.finish({ ok: false, detail: "not ready after 180s: voice (running, starting)", services: [
    { service: "cortex", status: "running" }, { service: "voice", status: "running", health: "starting" }, { service: "models", status: "exited", exitCode: 0 },
  ] });
  await tick(); await tick();
  assert.deepEqual(svc.snapshot().last, { kind: "launch", ok: false, detail: "not ready after 180s: voice (running, starting)", services: [{ service: "voice", status: "running", health: "starting" }], finishedAt: 99 });
  assert.equal(svc.snapshot().action, null);
  assert.ok(rec.lines.some((l) => l.level === "warn" && /launch/.test(String(l.msg))));
  assert.equal(svc.request("stop", restarter).ok, true); // the slot is free again
  f.finish({ ok: true });
  await tick(); await tick();
  assert.deepEqual(svc.snapshot().last, { kind: "stop", ok: true, finishedAt: 99 });
  assert.ok(rec.lines.some((l) => l.level === "info" && /stop/.test(String(l.msg))));
});

// @spec DASH-STACK-006
test("a controller that throws becomes a failed result, not a crash", async () => {
  const { svc, f, rec } = service();
  f.setStatus(up()); await svc.probe();
  f.ops.launch = async () => { throw new Error("spawn EACCES"); };
  svc.request("launch", restarter);
  await tick(); await tick();
  assert.equal(svc.snapshot().last!.ok, false);
  assert.match(svc.snapshot().last!.detail ?? "", /EACCES/);
  assert.ok(rec.lines.some((l) => l.level === "warn"));
});

// @spec DASH-FEED-008
test("onChange fires when the state, a container, the action, last or the bus changes, and not for identical probes or a reordered container list", async () => {
  const { svc, f, bus } = service();
  const seen: StackSnapshot[] = [];
  svc.onChange((s) => seen.push(s));
  f.setStatus(up()); await svc.probe();
  assert.equal(seen.length, 1);
  await svc.probe();
  f.setStatus({ docker: { ok: true }, services: [...up().services].reverse() }); await svc.probe();
  assert.equal(seen.length, 1);
  f.setStatus({ docker: { ok: true }, services: [{ service: "redis", status: "running", health: "unhealthy" }, { service: "cortex", status: "running" }] }); await svc.probe();
  assert.equal(seen.length, 2);
  bus.v = "unreachable"; svc.refresh();
  assert.equal(seen.length, 3);
  svc.refresh();
  assert.equal(seen.length, 3);
  svc.request("launch", restarter);
  assert.equal(seen.length, 4);
  svc.hooks.onPhase("launch", "waiting");
  assert.equal(seen.length, 5);
  svc.hooks.onPhase("launch", "waiting");
  assert.equal(seen.length, 5);
});

// ---------- the routes

const ON = { CONTROL_ENABLED: "1", CONTROL_TOKEN: "s3cret" };

class CtlBus extends FakeBus { async resetGroup() {} }

async function boot(env: NodeJS.ProcessEnv, statusAtBoot: StackStatus | null = up()) {
  const bus = new CtlBus();
  const rec = recordingLog();
  const lifecycle: string[] = [];
  let lifeGate: Promise<void> = Promise.resolve();
  const rt: Runtime = {
    name: "compose",
    async start(id) { lifecycle.push(`start ${id}`); await lifeGate; return { ok: true }; },
    async stop(id) { lifecycle.push(`stop ${id}`); await lifeGate; return { ok: true }; },
    async restart(id) { lifecycle.push(`restart ${id}`); await lifeGate; return { ok: true }; },
  };
  const setup = setupControl(env, bus, rec.log, rt);
  const svc = new StackService({ log: rec.log, bus: () => "connected" });
  const f = fakeOps(statusAtBoot ?? none);
  // statusAtBoot === null: nothing has been probed yet
  svc.attach(f.ops);
  if (statusAtBoot) await svc.probe();
  const server = http.createServer(createDashboardHandler({
    bus, log: rec.log, html: "x", cohostName: "Coco", voiceUrl: "http://127.0.0.1:1",
    loadPersonality: () => "p", savePersonality: () => {}, services: () => [], control: setup.control, stack: svc,
  }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const send = (path: string, init: { method?: string; body?: string; token?: string } = {}) =>
    fetch(`${base}${path}`, { method: init.method ?? "POST", body: init.body, headers: init.token ? { authorization: `Bearer ${init.token}` } : {} });
  return { svc, f, send, lifecycle, rec, holdLifecycle: () => { let open!: () => void; lifeGate = new Promise<void>((r) => { open = r; }); return open; } };
}

// @spec DASH-STACK-001, DASH-CTRL-005
test("GET /stack answers the snapshot in both control modes, without a token", async () => {
  for (const env of [{}, ON]) {
    const t = await boot(env);
    const r = await t.send("/stack", { method: "GET" });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /application\/json/);
    assert.deepEqual(await r.json(), t.svc.snapshot());
  }
});

// @spec DASH-STACK-002, DASH-CTRL-001
test("control disabled: every POST /stack/* is a 404 and nothing runs", async () => {
  const t = await boot({});
  for (const k of ["launch", "stop", "restart", "consolidate"]) assert.equal((await t.send(`/stack/${k}`)).status, 404);
  assert.deepEqual(t.f.calls.filter((c) => c !== "status"), []);
});

// @spec DASH-STACK-002, DASH-CTRL-004
test("a stack POST needs the bearer token: 401 with www-authenticate, nothing runs; a query-string token does not count", async () => {
  const t = await boot(ON);
  for (const token of [undefined, "wrong"]) {
    const r = await t.send("/stack/launch", { token });
    assert.equal(r.status, 401);
    assert.equal(r.headers.get("www-authenticate"), "Bearer");
  }
  assert.equal((await t.send("/stack/launch?token=s3cret")).status, 401);
  assert.equal((await t.send("/stack/launch", { body: JSON.stringify({ token: "s3cret" }) })).status, 401);
  assert.deepEqual(t.f.calls.filter((c) => c !== "status"), []);
});

// @spec DASH-STACK-002
test("an authorized stack POST answers 202 {ok, action} at once, ignores any body, and the action keeps running", async () => {
  const t = await boot(ON);
  const r = await t.send("/stack/launch", { token: "s3cret", body: JSON.stringify({ argv: ["rm", "-rf", "/"], kind: "stop" }) });
  assert.equal(r.status, 202);
  assert.deepEqual(await r.json(), { ok: true, action: "launch" });
  assert.deepEqual(t.f.calls.filter((c) => c !== "status"), ["launch"]);
  assert.equal(t.svc.snapshot().action!.kind, "launch");
  for (const [route, kind] of [["stop", "stop"], ["restart", "restart"], ["consolidate", "consolidate"]] as const) {
    t.f.finish({ ok: true }); await tick(); await tick();
    const x = await t.send(`/stack/${route}`, { token: "s3cret" });
    assert.equal(x.status, 202, route);
    assert.deepEqual(await x.json(), { ok: true, action: kind });
  }
});

// @spec DASH-STACK-003
test("a second stack POST is 409 busy: launch; a lifecycle POST is 409 too, and a lifecycle POST blocks a stack POST", async () => {
  const t = await boot(ON);
  await t.send("/stack/launch", { token: "s3cret" });
  const again = await t.send("/stack/launch", { token: "s3cret" });
  assert.equal(again.status, 409);
  assert.deepEqual(await again.json(), { ok: false, detail: "busy: launch" });
  const life = await t.send("/services/cortex/restart", { token: "s3cret" });
  assert.equal(life.status, 409);
  assert.deepEqual(await life.json(), { ok: false, detail: "busy: launch" });
  assert.deepEqual(t.lifecycle, []);
  t.f.finish({ ok: true }); await tick(); await tick();

  const open = t.holdLifecycle();
  const pending = t.send("/services/cortex/restart", { token: "s3cret" });
  await new Promise((r) => setTimeout(r, 30));
  const blocked = await t.send("/stack/stop", { token: "s3cret" });
  assert.equal(blocked.status, 409);
  assert.match(((await blocked.json()) as { detail: string }).detail, /^busy: service-restart$/);
  open();
  assert.equal((await pending).status, 200);
  assert.equal((await t.send("/stack/stop", { token: "s3cret" })).status, 202); // the lifecycle request released the slot
});

// @spec DASH-STACK-004, DASH-STACK-005
test("503 when Docker is unavailable (or never probed), 409 for a failed precondition", async () => {
  const noProbe = await boot(ON, null);
  const a = await noProbe.send("/stack/launch", { token: "s3cret" });
  assert.equal(a.status, 503);
  assert.equal(((await a.json()) as { ok: boolean }).ok, false);
  const d = await boot(ON, noDocker);
  const b = await d.send("/stack/stop", { token: "s3cret" });
  assert.equal(b.status, 503);
  assert.equal(((await b.json()) as { detail: string }).detail, "docker: command not found");
  const down = await boot(ON, none);
  const c = await down.send("/stack/restart", { token: "s3cret" });
  assert.equal(c.status, 409);
  assert.equal(((await c.json()) as { ok: boolean }).ok, false);
});

// @spec DASH-STACK-002
test("refusals are checked in order: 401 before 409 busy before 503 before 409 precondition", async () => {
  const t = await boot(ON, noDocker);
  assert.equal((await t.send("/stack/restart")).status, 401); // no token beats docker unavailable
  const busy = await boot(ON);
  await busy.send("/stack/launch", { token: "s3cret" });
  busy.f.setStatus(noDocker); await busy.svc.probe();
  assert.equal((await busy.send("/stack/stop", { token: "s3cret" })).status, 409); // busy beats docker unavailable
});

// @spec DASH-STACK-002
test("unknown stack routes and GET on a stack action are 404", async () => {
  const t = await boot(ON);
  assert.equal((await t.send("/stack/explode", { token: "s3cret" })).status, 404);
  assert.equal((await t.send("/stack/launch", { method: "GET" })).status, 404);
});
