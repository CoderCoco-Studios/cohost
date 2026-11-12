import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeBus, recordingLog, testConfig, waitFor } from "@cohost/testing";
import { runService } from "@cohost/shared";
import type { StackService, StackOps } from "../src/stack.js";
import { dashboardService } from "../src/service.js";

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

function rig(env: NodeJS.ProcessEnv) {
  const bus = new DashBus();
  const rec = recordingLog();
  const exits: number[] = [];
  let shutdown: (() => void | Promise<void>) | undefined;
  const svc = dashboardService({ env: { PORT: "0", DASHBOARD_LAN_PORT: "0", ...env }, exit: (c) => { exits.push(c); }, lanHost: "127.0.0.1", attachStack: idleStack });
  const start = () => runService({
    service: "dashboard", health: svc.health, main: svc.main,
    loadConfig: () => testConfig(), createBus: () => bus as never, log: rec.log,
    onShutdown: (fn) => { shutdown = fn; }, exit: (c) => { exits.push(c); },
  });
  return { bus, rec, exits, start, stop: async () => { await shutdown?.(); } };
}

const states = (bus: DashBus) => bus.health.filter((h) => h.service === "dashboard").map((h) => h.state);

// @spec DASH-HTTP-016, DASH-HEALTH-001
test("the dashboard runs on runService: it is `starting` first, `ready` once both listeners listen, and shutdown stops the bus", async (t) => {
  const r = rig({});
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
  const r = rig({ CONTROL_ENABLED: "1", CONTROL_TOKEN: "" });
  t.after(() => r.stop());
  await r.start();
  assert.deepEqual(r.exits, [1]);
  assert.ok(!states(r.bus).includes("ready"));
});

// @spec DASH-HTTP-016, DASH-HOST-003
test("a listener that cannot bind exits 1 and the dashboard is never ready", async (t) => {
  const first = rig({});
  t.after(() => first.stop());
  await first.start();
  const addr = first.rec.lines.find((l) => String(l.msg).startsWith("dashboard online:"))!.obj as { url: string };
  const taken = new URL(addr.url).port;
  const second = rig({ PORT: taken });
  t.after(() => second.stop());
  await second.start();
  assert.deepEqual(second.exits, [1]);
  assert.ok(!states(second.bus).includes("ready"));
  assert.ok(second.rec.lines.some((l) => l.level === "fatal"));
});
