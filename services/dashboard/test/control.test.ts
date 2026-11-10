import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { FakeBus, recordingLog } from "@cohost/testing";
import type { Runtime } from "@cohost/control";
import { createDashboardHandler } from "../src/routes.js";
import { setupControl } from "../src/control.js";

class CtlBus extends FakeBus {
  resets: string[] = [];
  async resetGroup(g: string) { this.resets.push(g); }
}

function fakeRuntime() {
  const calls: string[] = [];
  const rt: Runtime = {
    name: "compose",
    async start(id) { calls.push(`start ${id}`); return { ok: true }; },
    async stop(id) { calls.push(`stop ${id}`); return { ok: true }; },
    async restart(id) { calls.push(`restart ${id}`); return { ok: true }; },
  };
  return { rt, calls };
}

async function boot(env: NodeJS.ProcessEnv) {
  const bus = new CtlBus();
  const rec = recordingLog();
  const { rt, calls } = fakeRuntime();
  const setup = setupControl(env, bus, rec.log, rt);
  let personality = "p";
  const server = http.createServer(createDashboardHandler({
    bus, log: rec.log, html: "x", cohostName: "Coco", voiceUrl: "http://127.0.0.1:1",
    loadPersonality: () => personality, savePersonality: (t) => { personality = t; },
    services: () => [], control: setup.control,
  }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const send = (path: string, init: { method?: string; body?: unknown; token?: string } = {}) =>
    fetch(`${base}${path}`, {
      method: init.method ?? "POST",
      body: init.body === undefined ? undefined : typeof init.body === "string" ? init.body : JSON.stringify(init.body),
      headers: init.token ? { authorization: `Bearer ${init.token}` } : {},
    });
  return { bus, calls, setup, send, rec, get personality() { return personality; } };
}

// @spec DASH-CTRL-001
test("disabled: service routes 404, /control and /personality stay open, flag reports disabled", async () => {
  const t = await boot({});
  assert.equal(t.setup.control, undefined);
  assert.equal(t.setup.bind, undefined);
  assert.equal((await t.send("/services/cortex/stop")).status, 404);
  assert.equal((await t.send("/control", { body: { cmd: "mute" } })).status, 204);
  assert.equal((await t.send("/personality", { method: "PUT", body: "hi" })).status, 204);
  assert.deepEqual(await (await t.send("/services/control", { method: "GET" })).json(), { enabled: false });
  assert.deepEqual(t.calls, []);
});

const ON = { CONTROL_ENABLED: "1", CONTROL_TOKEN: "s3cret" };

// @spec DASH-CTRL-002
test("enabling without a token fails startup naming CONTROL_TOKEN", () => {
  assert.throws(() => setupControl({ CONTROL_ENABLED: "1" }, new CtlBus(), recordingLog().log), /CONTROL_TOKEN/);
});

// @spec DASH-CTRL-003
test("bind: loopback by default, CONTROL_BIND overrides and warns when non-loopback", () => {
  const a = recordingLog();
  assert.equal(setupControl(ON, new CtlBus(), a.log).bind, "127.0.0.1");
  assert.deepEqual(a.msgs("warn"), []);
  const b = recordingLog();
  assert.equal(setupControl({ ...ON, CONTROL_BIND: "0.0.0.0" }, new CtlBus(), b.log).bind, "0.0.0.0");
  assert.equal(b.msgs("warn").length, 1);
  const c = recordingLog();
  assert.equal(setupControl({ ...ON, CONTROL_BIND: "127.0.0.1" }, new CtlBus(), c.log).bind, "127.0.0.1");
  assert.deepEqual(c.msgs("warn"), []);
});

// @spec DASH-CTRL-004
test("enabled: every mutating route needs the bearer token (401 otherwise, nothing happens)", async () => {
  const t = await boot(ON);
  const before = t.bus.published.length;
  for (const token of [undefined, "wrong"]) {
    assert.equal((await t.send("/control", { body: { cmd: "mute" }, token })).status, 401);
    assert.equal((await t.send("/personality", { method: "PUT", body: "evil", token })).status, 401);
    assert.equal((await t.send("/services/voice/stop", { token })).status, 401);
  }
  assert.equal(t.bus.published.length, before);
  assert.equal(t.personality, "p");
  assert.deepEqual(t.calls, []);
});

// @spec DASH-CTRL-004, DASH-HTTP-008
test("enabled + token: POST /control (incl. targeted pause) and PUT /personality succeed", async () => {
  const t = await boot(ON);
  assert.equal((await t.send("/control", { body: { cmd: "pause", target: "affect" }, token: "s3cret" })).status, 204);
  assert.deepEqual(t.bus.of("control").map((c) => [c.cmd, c.target]), [["pause", "affect"]]);
  assert.equal((await t.send("/personality", { method: "PUT", body: "new", token: "s3cret" })).status, 204);
  assert.equal(t.personality, "new");
});

// @spec DASH-CTRL-005, DASH-CTRL-007
test("GET /services/control reports enabled without needing a token", async () => {
  const t = await boot(ON);
  assert.deepEqual(await (await t.send("/services/control", { method: "GET" })).json(), { enabled: true, runtime: "compose", advanced: false });
});

// @spec DASH-CTRL-007
test("setupControl without an injected runtime always selects the compose runtime", () => {
  const setup = setupControl({ ...ON, CONTROL_RUNTIME: "process", CONTROL_PROCESS_MODE: "start" }, new CtlBus(), recordingLog().log);
  assert.equal(setup.control?.runtime, "compose");
});

// @spec DASH-SVC-001
test("restart cortex: 200 {ok:true}, stop->reset->start, audited as dashboard", async () => {
  const t = await boot(ON);
  const r = await t.send("/services/cortex/restart", { token: "s3cret" });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  assert.deepEqual(t.calls, ["stop cortex", "start cortex"]);
  assert.deepEqual(t.bus.resets, ["cortex"]);
  assert.deepEqual(t.bus.of("service.lifecycle"), [{ service: "cortex", action: "restart", by: "dashboard", ok: true }]);
});

// @spec DASH-SVC-002
test("body: mode override is honoured; bad bodies are 400 and run nothing", async () => {
  const t = await boot(ON);
  await t.send("/services/memory/restart", { body: { mode: "fresh" }, token: "s3cret" });
  assert.deepEqual(t.bus.resets, ["memory", "memory-recall", "memory-notes"]);
  t.calls.length = 0;
  for (const body of ["{nope", { mode: "sideways" }, { isolated: "yes" }, "[1]"]) {
    assert.equal((await t.send("/services/memory/start", { body, token: "s3cret" })).status, 400);
  }
  assert.deepEqual(t.calls, []);
});

// @spec DASH-SVC-002
test("isolated start is accepted in the body", async () => {
  const t = await boot(ON);
  assert.equal((await t.send("/services/salience/start", { body: { isolated: true }, token: "s3cret" })).status, 200);
  assert.deepEqual(t.calls, ["start salience"]);
});

// @spec DASH-SVC-003
test("unknown id 404, crafted id 404, nothing executed or audited", async () => {
  const t = await boot(ON);
  assert.equal((await t.send("/services/nope/start", { token: "s3cret" })).status, 404);
  assert.equal((await t.send(`/services/${encodeURIComponent("cortex; rm -rf /")}/stop`, { token: "s3cret" })).status, 404);
  assert.deepEqual(t.calls, []);
  assert.deepEqual(t.bus.of("service.lifecycle"), []);
});

// @spec DASH-SVC-003
test("dashboard is not a manifest unit (404); infra is 403 unless CONTROL_ADVANCED=1", async () => {
  const t = await boot(ON);
  assert.equal((await t.send("/services/dashboard/stop", { token: "s3cret" })).status, 404);
  assert.equal((await t.send("/services/dashboard/restart", { token: "s3cret" })).status, 404);
  assert.equal((await t.send("/services/redis/stop", { token: "s3cret" })).status, 403);
  assert.deepEqual(t.calls, []);
  const adv = await boot({ ...ON, CONTROL_ADVANCED: "1" });
  assert.equal((await adv.send("/services/postgres/stop", { token: "s3cret" })).status, 200);
  assert.deepEqual(adv.calls, ["stop postgres"]);
});

// @spec DASH-SVC-004
test("a failed audit publish does not fail the request", async () => {
  const t = await boot(ON);
  t.bus.fail = (type) => type === "service.lifecycle";
  assert.equal((await t.send("/services/voice/stop", { token: "s3cret" })).status, 200);
});

// @spec DASH-HTTP-011
test("lifecycle body over 64 KiB is a 413 and runs nothing", async () => {
  const t = await boot(ON);
  const big = JSON.stringify({ mode: "resume", pad: "x".repeat(64 * 1024) });
  for (const act of ["start", "stop", "restart"]) {
    assert.equal((await t.send(`/services/cortex/${act}`, { body: big, token: "s3cret" })).status, 413);
  }
  assert.deepEqual(t.calls, []);
  assert.deepEqual(t.bus.of("service.lifecycle"), []);
});

// @spec DASH-HTTP-013
test("a malformed % escape in the service id is a 404 like an unknown service, not a 500", async () => {
  const t = await boot(ON);
  t.rec.lines.length = 0;
  for (const id of ["%E0%A4%A", "%", "cortex%zz"]) {
    const r = await t.send(`/services/${id}/stop`, { token: "s3cret" });
    assert.equal(r.status, 404, id);
    assert.equal(((await r.json()) as { ok: boolean }).ok, false);
  }
  assert.deepEqual(t.calls, []);
  assert.deepEqual(t.rec.msgs("error"), []);
});
