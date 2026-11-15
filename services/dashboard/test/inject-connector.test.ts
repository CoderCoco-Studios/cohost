import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { FakeBus, recordingLog } from "@cohost/testing";
import type { HealthState, ServiceHealth } from "@cohost/control";
import { createDashboardHandler } from "../src/routes.js";
import { setupControl } from "../src/control.js";
import { StackService } from "../src/stack.js";

// The audio route's `?target=` (DASH-INJ-010): the Discord connector's test input rides the same upload path as ears'.

const ids = ["chat", "eyes", "ears", "connector-discord"];

async function boot(states: Record<string, HealthState> = {}) {
  const bus = new (class extends FakeBus { async resetGroup() {} })();
  const rec = recordingLog();
  const setup = setupControl({}, bus, rec.log);
  const services = (): ServiceHealth[] => ids.map((service) => ({ service, state: states[service] ?? "up", restarts: 0 }));
  const server = http.createServer(createDashboardHandler({
    bus, log: rec.log, html: "x", cohostName: "Coco", voiceUrl: "http://127.0.0.1:1",
    loadPersonality: () => "p", savePersonality: () => {}, services,
    control: setup.control,
    uploads: { maxImageBytes: 64, maxAudioBytes: 64, ttlMs: 300_000 },
    stack: new StackService({ log: rec.log, bus: () => "connected" }),
  }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (path: string, type = "audio/wav", body: BodyInit = Buffer.from("RIFFDATA")) =>
    fetch(`${base}${path}`, { method: "POST", body, headers: { "content-type": type } });
  return { bus, post };
}

// @spec DASH-INJ-010
test("?target=connector-discord stores the clip and publishes an audio inject.request for the connector", async () => {
  const t = await boot();
  const r = await t.post("/inject/audio?level=service&target=connector-discord&remember=1");
  assert.equal(r.status, 202);
  const { id } = (await r.json()) as { id: string };
  const [req] = t.bus.of("inject.request");
  assert.equal(req!.id, id);
  assert.equal(req!.target, "connector-discord");
  assert.equal(req!.kind, "audio");
  assert.equal(req!.contentType, "audio/wav");
  assert.ok(t.bus.uploads.has(req!.uploadId!));
});

// @spec DASH-INJ-010
test("an audio request without ?target= or with ?target=ears targets ears", async () => {
  const t = await boot();
  assert.equal((await t.post("/inject/audio")).status, 202);
  assert.equal((await t.post("/inject/audio?target=ears")).status, 202);
  assert.deepEqual(t.bus.of("inject.request").map((r) => r.target), ["ears", "ears"]);
});

// @spec DASH-INJ-010
test("another ?target=, ?target= on image, and ?target=connector-discord with ?source= are 400 and store and publish nothing", async () => {
  const t = await boot();
  for (const [path, type] of [
    ["/inject/audio?target=eyes", "audio/wav"], ["/inject/audio?target=nope", "audio/wav"], ["/inject/audio?target=", "audio/wav"],
    ["/inject/image?target=eyes", "image/png"], ["/inject/audio?target=connector-discord&source=desk", "audio/wav"],
  ] as const) assert.equal((await t.post(path, type)).status, 400, path);
  assert.equal(t.bus.published.length, 0);
  assert.equal(t.bus.uploads.size, 0);
});

// @spec DASH-INJ-010, MOD-TEST-005
test("the not-running refusal names the connector for its target, and the ears target is not refused while only the connector is down", async () => {
  const t = await boot({ "connector-discord": "down" });
  const r = await t.post("/inject/audio?target=connector-discord");
  assert.equal(r.status, 409);
  assert.deepEqual(await r.json(), { ok: false, detail: "service not running: connector-discord" });
  assert.equal(t.bus.published.length, 0);
  assert.equal((await t.post("/inject/audio?target=ears")).status, 202);
});
