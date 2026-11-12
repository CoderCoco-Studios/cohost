import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { FakeBus, recordingLog } from "@cohost/testing";
import { HealthTracker } from "@cohost/control";
import { createDashboardHandler, type DashboardDeps } from "../src/routes.js";
import { StackService } from "../src/stack.js";

function start(control?: DashboardDeps["control"]) {
  const bus = new FakeBus();
  const rec = recordingLog();
  const server = http.createServer(createDashboardHandler({
    bus, log: rec.log, html: "<h1>__COHOST_NAME__</h1>", cohostName: "Coco", voiceUrl: "http://127.0.0.1:1",
    loadPersonality: () => "", savePersonality: () => {}, services: () => new HealthTracker().snapshot(),
    stack: new StackService({ log: rec.log, bus: () => "connected" }), control,
  }));
  return new Promise<{ bus: FakeBus; base: string }>((resolve) => {
    server.listen(0, () => {
      after(() => server.close());
      resolve({ bus, base: `http://127.0.0.1:${(server.address() as { port: number }).port}` });
    });
  });
}
const post = (base: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/mouth/routing`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });

// @spec DASH-ROUTE-001
test("POST /mouth/routing publishes set_routing addressed to mouth with the outputs map and answers 204", async () => {
  const { bus, base } = await start();
  const r = await post(base, { outputs: { discord: { enabled: false, gain_db: -6 }, dryrun: { enabled: true } } });
  assert.equal(r.status, 204);
  assert.deepEqual(bus.of("control"), [{ cmd: "set_routing", target: "mouth", routing: { discord: { enabled: false, gain_db: -6 }, dryrun: { enabled: true } } }]);
});

// @spec DASH-ROUTE-001
test("with CONTROL_ENABLED the route needs the bearer token", async () => {
  const { bus, base } = await start({ token: "s3cret", runtime: "compose", advanced: false, controller: {} as never });
  const body = { outputs: { discord: { enabled: false } } };
  assert.equal((await post(base, body)).status, 401);
  assert.equal((await post(base, body, { authorization: "Bearer wrong" })).status, 401);
  assert.equal(bus.of("control").length, 0);
  assert.equal((await post(base, body, { authorization: "Bearer s3cret" })).status, 204);
  assert.equal(bus.of("control").length, 1);
});

// @spec DASH-ROUTE-002
test("a body that is not JSON, has no outputs, or has a bad entry is a 400 and publishes nothing; an unknown output id is left to mouth", async () => {
  const { bus, base } = await start();
  const bad: unknown[] = [
    "not json",
    [],
    {},
    { outputs: {} },
    { outputs: [] },
    { outputs: { discord: { enabled: "yes" } } },
    { outputs: { discord: { gain_db: "loud" } } },
    { outputs: { discord: { gain_db: 13 } } },
    { outputs: { discord: { gain_db: -41 } } },
    { outputs: { discord: { volume: 1 } } },
    { outputs: { discord: 5 } },
  ];
  for (const body of bad) assert.equal((await post(base, body)).status, 400, JSON.stringify(body));
  assert.equal(bus.of("control").length, 0);
  assert.equal((await post(base, { outputs: { discrod: { enabled: false } } })).status, 204, "unknown ids are mouth's to reject (MOUTH-LIVE-003)");
});

// @spec DASH-ROUTE-003
test("the dashboard keeps no routing state: GET /mouth/routing does not exist and routing is read from the services' heartbeat detail", async () => {
  const { base } = await start();
  assert.equal((await fetch(`${base}/mouth/routing`)).status, 404);
  assert.equal((await fetch(`${base}/services`)).status, 200);
});
