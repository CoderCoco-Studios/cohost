import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { FakeBus, recordingLog, testConfig, waitFor } from "@cohost/testing";
import { runService, WAITING_FOR_CREDENTIALS } from "@cohost/shared";
import type { StackService, StackOps } from "../src/stack.js";
import { dashboardService } from "../src/service.js";
import type { Redeliver } from "../src/deliver.js";
import { SESSION_COOKIE } from "../src/access.js";
import { AUTH, TOKEN } from "./control-fixture.js";
import { testStore } from "./store-fixture.js";

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

/** One `redeliver` call as the fake saw it. */
interface Delivery { waiting: string[]; ready: string[] }

async function rig(env: NodeJS.ProcessEnv, ports?: { port?: number; lan_port?: number; allowed_hosts?: string[] }, o: { seed?: { service: string; state: string; detail?: string }[] } = {}) {
  const dashboard = { port: ports?.port ?? await freePort(), lan_port: ports?.lan_port ?? await freePort(), ...(ports?.allowed_hosts ? { allowed_hosts: ports.allowed_hosts } : {}) };
  const bus = new DashBus();
  for (const h of o.seed ?? []) bus.health.push({ instance: "i", pid: 1, version: "0", startedAt: 0, deps: {}, mode: "live", ...h } as never);
  const rec = recordingLog();
  const exits: number[] = [];
  const st = await testStore();
  after(() => st.close());
  const deliveries: Delivery[] = [];
  const redeliver: Redeliver = async ({ waiting, ready }) => {
    deliveries.push({ waiting: [...waiting].toSorted(), ready: [...ready].toSorted() });
    return { delivered: [...waiting], failures: [] };
  };
  const printed: string[] = [];
  let shutdown: (() => void | Promise<void>) | undefined;
  const svc = dashboardService({
    store: st.store, root: st.root, redeliver, print: (l) => { printed.push(l); },
    env, exit: (c) => { exits.push(c); }, lanHost: "127.0.0.1", attachStack: idleStack,
  });
  const start = () => runService({
    service: "dashboard", health: svc.health, main: svc.main,
    loadConfig: () => testConfig({ dashboard }), createBus: () => bus as never, log: rec.log,
    onShutdown: (fn) => { shutdown = fn; }, exit: (c) => { exits.push(c); },
  });
  const full = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${dashboard.port}${path}`, init);
  return { bus, rec, exits, dashboard, start, store: st.store, deliveries, printed, full, stop: async () => { await shutdown?.(); } };
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

// @spec DASH-CTRL-011, STORE-TOK-003
test("the gate checks a bearer against the store's verifier: the right token passes, a wrong one is 401 with nothing published", async (t) => {
  const r = await rig({});
  t.after(() => r.stop());
  await r.start();
  await waitFor(() => states(r.bus).includes("ready"), "a ready heartbeat");
  r.bus.clear();
  const mute = (headers: Record<string, string>) => r.full("/control", { method: "POST", headers, body: JSON.stringify({ cmd: "mute" }) });
  assert.equal((await mute({ authorization: `Bearer ${TOKEN}x` })).status, 401);
  assert.equal((await mute({})).status, 401);
  assert.equal(r.bus.of("control").length, 0);
  assert.equal((await mute(AUTH)).status, 204);
  assert.equal(r.bus.of("control").length, 1);
});

// @spec DASH-CTRL-011, STORE-TOK-003
test("while too many token checks wait the gate answers 429 with retry-after: 1, and no request it refused acts", async (t) => {
  const r = await rig({});
  t.after(() => r.stop());
  await r.start();
  await waitFor(() => states(r.bus).includes("ready"), "a ready heartbeat");
  r.bus.clear();
  // Distinct wrong tokens, so none is remembered: one check runs, four wait, the rest are refused at once.
  const answers = await Promise.all(Array.from({ length: 10 }, (_, i) =>
    r.full("/control", { method: "POST", headers: { authorization: `Bearer wrong-token-number-${i}-0123456789abcdef` }, body: JSON.stringify({ cmd: "mute" }) })));
  const busy = answers.filter((a) => a.status === 429);
  assert.ok(busy.length > 0, `some answer is 429: ${answers.map((a) => a.status).join(",")}`);
  for (const a of busy) assert.equal(a.headers.get("retry-after"), "1");
  for (const a of answers) assert.ok(a.status === 401 || a.status === 429, String(a.status));
  assert.equal(r.bus.of("control").length, 0);
});

// @spec DASH-UNL-005, DASH-UNL-001, STORE-TOK-004
test("the printed link makes a session under the store's session key; setting a new token (mise run config:token) ends every session", async (t) => {
  const r = await rig({});
  t.after(() => r.stop());
  await r.start();
  await waitFor(() => r.printed.length > 0, "the unlock line");
  const link = /^Unlock this browser: (http:\/\/\S+)$/.exec(r.printed[0]!)![1]!;
  const opened = await fetch(link, { redirect: "manual" });
  assert.equal(opened.status, 303);
  const cookie = opened.headers.get("set-cookie")!.split(";")[0]!;
  assert.ok(cookie.startsWith(`${SESSION_COOKIE}=`));
  const unlocked = async () => ((await (await r.full("/services/control", { headers: { cookie } })).json()) as { unlocked: boolean }).unlocked;
  assert.equal(await unlocked(), true);
  r.store.setToken("a-brand-new-control-token-0123456789abcdef");
  assert.equal(await unlocked(), false, "a new session key ends the session");
  assert.equal((await r.full("/control", { method: "POST", headers: { cookie, origin: `http://127.0.0.1:${r.dashboard.port}` }, body: JSON.stringify({ cmd: "mute" }) })).status, 401);
  assert.equal((await r.full("/control", { method: "POST", headers: AUTH, body: JSON.stringify({ cmd: "mute" }) })).status, 401, "the old token is gone too");
});

// @spec STORE-DLV-005
test("after the heartbeat seed the dashboard re-delivers credentials to the units waiting for them, logging each", async (t) => {
  const r = await rig({}, undefined, { seed: [
    { service: "cortex", state: "starting", detail: WAITING_FOR_CREDENTIALS },
    { service: "voice", state: "ready" },
  ] });
  t.after(() => r.stop());
  await r.start();
  await waitFor(() => r.deliveries.length > 0, "a delivery");
  assert.deepEqual(r.deliveries[0], { waiting: ["cortex"], ready: ["voice"] });
  await waitFor(() => r.rec.lines.some((l) => l.msg === "delivered credentials to cortex"), "the delivery's log line");
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
