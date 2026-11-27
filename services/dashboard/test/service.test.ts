import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { FakeBus, recordingLog, testConfig, waitFor } from "@cohost/testing";
import { runService } from "@cohost/shared";
import type { StackService, StackOps } from "../src/stack.js";
import { dashboardService } from "../src/service.js";
import { ON } from "./control-fixture.js";

/** A bus that also answers what the feed reads (FakeBus only records). */
class DashBus extends FakeBus {
  stopped = 0;
  stop(): void { this.stopped++; }
  async recent(): Promise<never[]> { return []; }
  async tail(): Promise<void> {}
  async tailHealth(): Promise<void> {}
}

const idleStack = (s: StackService): void => {
  const ops: StackOps = {
    status: async () => ({ docker: { ok: true }, services: [] }),
    launch: async () => ({ ok: true }) as never,
    rebuild: async () => ({ ok: true }) as never,
    stopAll: async () => ({ ok: true }) as never,
    restartAll: async () => ({ ok: true }) as never,
    consolidate: async () => ({ ok: true }) as never,
  };
  s.attach(ops);
};

/** A port nothing listens on right now (the config has no "any port" value, so each rig takes real ones). */
async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as net.AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

async function rig(env: NodeJS.ProcessEnv, ports?: { port?: number; lan_port?: number; allowed_hosts?: string[] }) {
  const dashboard = { port: ports?.port ?? await freePort(), lan_port: ports?.lan_port ?? await freePort(), ...(ports?.allowed_hosts ? { allowed_hosts: ports.allowed_hosts } : {}) };
  const bus = new DashBus();
  const rec = recordingLog();
  const exits: number[] = [];
  let shutdown: (() => void | Promise<void>) | undefined;
  const svc = dashboardService({ env: { ...ON, ...env }, exit: (c) => { exits.push(c); }, lanHost: "127.0.0.1", attachStack: idleStack });
  const start = () => runService({
    service: "dashboard", health: svc.health, main: svc.main,
    loadConfig: () => testConfig({ dashboard }), createBus: () => bus as never, log: rec.log,
    onShutdown: (fn) => { shutdown = fn; }, exit: (c) => { exits.push(c); },
  });
  return { bus, rec, exits, dashboard, start, stop: async () => { await shutdown?.(); } };
}

const states = (bus: DashBus) => bus.health.filter((h) => h.service === "dashboard").map((h) => h.state);

// @spec DASH-HTTP-016, DASH-HEALTH-001
test("the dashboard runs on runService: it is `starting` first, `ready` once both listeners listen, and shutdown stops the bus", async (t) => {
  const r = await rig({});
  t.after(() => r.stop());
  await r.start();
  assert.deepEqual(r.exits, []);
  await waitFor(() => states(r.bus).includes("ready"), "a ready heartbeat");
  assert.equal(states(r.bus)[0], "starting");
  assert.ok(r.rec.lines.some((l) => String(l.msg).startsWith("dashboard online:")));
  await r.stop();
  assert.equal(r.bus.stopped, 1);
});

// @spec DASH-HTTP-016, DASH-CTRL-002
test("a control configuration that cannot start ends the process with status 1 and never reaches ready", async (t) => {
  const r = await rig({ CONTROL_TOKEN: "" });
  t.after(() => r.stop());
  await r.start();
  assert.deepEqual(r.exits, [1]);
  assert.ok(!states(r.bus).includes("ready"));
});

// @spec DASH-HTTP-016, DASH-HOST-003
test("a listener that cannot bind exits 1 and the dashboard is never ready", async (t) => {
  const first = await rig({});
  t.after(() => first.stop());
  await first.start();
  assert.ok(first.rec.lines.some((l) => String(l.msg).startsWith("dashboard online:")), "the first dashboard is online");
  const second = await rig({}, { port: first.dashboard.port });
  t.after(() => second.stop());
  await second.start();
  assert.deepEqual(second.exits, [1]);
  assert.ok(!states(second.bus).includes("ready"));
  assert.ok(second.rec.lines.some((l) => l.level === "fatal"));
});

// @spec DASH-HTTP-009, DASH-HOST-001
test("the listeners bind dashboard.port and dashboard.lan_port of the config; PORT, DASHBOARD_PORT and DASHBOARD_LAN_PORT are not read", async (t) => {
  const r = await rig({ PORT: "1", DASHBOARD_PORT: "2", DASHBOARD_LAN_PORT: "3" });
  t.after(() => r.stop());
  await r.start();
  await waitFor(() => states(r.bus).includes("ready"), "a ready heartbeat");
  assert.deepEqual(r.exits, []);
  const online = r.rec.lines.find((l) => String(l.msg).startsWith("dashboard online:"))!.obj as { url: string; lanPort: number };
  assert.equal(new URL(online.url).port, String(r.dashboard.port));
  assert.equal(online.lanPort, r.dashboard.lan_port);
  assert.equal((await fetch(`http://127.0.0.1:${r.dashboard.lan_port}/health`)).status, 200);
});

// @spec DASH-HOST-009, CFG-SCH-041
test("dashboard.allowed_hosts of the loaded config decides which names the LAN listener accepts in Host", async (t) => {
  const r = await rig({}, { allowed_hosts: ["streampc"] });
  t.after(() => r.stop());
  await r.start();
  const get = (host: string): Promise<number> => new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: r.dashboard.lan_port, path: "/health", headers: { host } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); }).on("error", reject);
  });
  assert.equal(await get("streampc:3001"), 200, "a listed name");
  assert.equal(await get("192.168.1.5:3001"), 200, "an address");
  assert.equal(await get("otherpc:3001"), 403, "a name that is not listed");
});
