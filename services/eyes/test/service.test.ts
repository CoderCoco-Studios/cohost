import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { FakeBus, event, recordingLog, testConfig, waitFor } from "@cohost/testing";
import { runService } from "@cohost/shared";
import { eyesService, nextDelay, type ObsClient } from "../src/service.js";

/** A bus that also answers the inject subscription calls and hands the inject handler to the test. */
class SvcBus extends FakeBus {
  handler?: (ev: never) => void;
  groups: string[] = [];
  subscribeOpts?: unknown;
  stopped = 0;
  async resetGroup(g: string): Promise<void> { this.groups.push(g); }
  async subscribe(opts: unknown, handler: (ev: never) => void): Promise<void> { this.subscribeOpts = opts; this.handler = handler; }
  stop(): void { this.stopped++; }
}

class FakeObs extends EventEmitter implements ObsClient {
  identified = false;
  connects = 0;
  disconnects = 0;
  calls: { request: string; args: Record<string, unknown> }[] = [];
  constructor(public connectFailures = 0) { super(); }
  async connect(url: string): Promise<{ obsWebSocketVersion: string }> {
    this.connects++;
    if (this.connects <= this.connectFailures) throw new Error("refused");
    this.identified = true;
    this.url = url;
    return { obsWebSocketVersion: "5.1.0" };
  }
  url = "";
  async disconnect(): Promise<void> { this.disconnects++; this.identified = false; }
  async call(request: string, args: Record<string, unknown>): Promise<{ imageData: string }> {
    this.calls.push({ request, args });
    return { imageData: `data:image/jpg;base64,${Buffer.from("FRAME").toString("base64")}` };
  }
}

function rig(over: Record<string, unknown>, deps: Record<string, unknown> = {}, obs = new FakeObs()) {
  const bus = new SvcBus();
  const rec = recordingLog();
  const exits: number[] = [];
  let shutdown: (() => void | Promise<void>) | undefined;
  let heartbeat: { stop(): Promise<void> } | undefined;
  const svc = eyesService({
    obs, exit: (c) => { exits.push(c); }, sleep: () => new Promise((r) => setTimeout(r, 2)),
    dashboardUrl: "http://dash:3000", ...deps,
  });
  const cfg = testConfig({ vision: { model: "v", engine: "stub", interval_ms: 1000, ...over } });
  const start = () => runService({
    service: "eyes", health: () => svc.health(cfg), main: async (ctx) => { heartbeat = ctx.heartbeat; await svc.main(ctx); },
    loadConfig: () => cfg, createBus: () => bus as never, log: rec.log,
    onShutdown: (fn) => { shutdown = fn; }, exit: (c) => { exits.push(c); },
  });
  return { bus, rec, obs, exits, start, stop: async () => { await shutdown?.(); await heartbeat?.stop(); } };
}
const heartbeats = (b: SvcBus) => b.health;

// @spec EYES-ENAB-001, EYES-ENAB-002, EYES-ENAB-004, EYES-HEALTH-001
test("vision disabled: one idle warning, never repeated, ready with mode off, no OBS, and the inject subscription is up", async () => {
  const r = rig({ enabled: false });
  try {
    await r.start();
    await new Promise((x) => setTimeout(x, 80));
    assert.equal(r.rec.msgs("warn").filter((m) => /vision\.enabled/.test(String(m))).length, 1, "one warning");
    assert.equal(r.obs.connects, 0);
    assert.deepEqual(r.bus.groups, ["eyes"]);
    assert.deepEqual(r.bus.subscribeOpts, { group: "eyes", types: ["inject.request"], start: "latest" });
    await waitFor(() => heartbeats(r.bus).some((h) => h.state === "ready" && h.mode === "off"), "ready off");
  } finally { await r.stop(); }
});

// @spec EYES-ENAB-005, EYES-OBS-008
test("shutdown with vision disabled stops the idle plan and the bus once; enabled it also closes OBS", async () => {
  const off = rig({ enabled: false });
  await off.start();
  await off.stop();
  assert.equal(off.bus.stopped, 1);
  assert.equal(off.obs.disconnects, 1, "the link is closed in both plans");

  const on = rig({ enabled: true });
  await on.start();
  await waitFor(() => on.obs.identified, "obs connected");
  await on.stop();
  assert.equal(on.obs.disconnects, 1);
  assert.equal(on.bus.stopped, 1);
});

// @spec EYES-ENAB-003, EYES-OBS-001, EYES-OBS-006, EYES-LOOK-001, EYES-STUB-001, EYES-STUB-002
test("enabled with the stub engine: OBS connects, the screenshot uses the configured width and quality, one stub summary is published, mode is mock", async () => {
  const r = rig({ enabled: true, jpeg_quality: 55, obs: { host: "obs.local", port: 4456, source: "Cam", width: 640, password: "pw" } });
  try {
    await r.start();
    await waitFor(() => r.bus.of("vision.summary").length === 1, "summary");
    assert.equal(r.obs.url, "ws://obs.local:4456");
    assert.deepEqual(r.obs.calls[0], { request: "GetSourceScreenshot", args: { sourceName: "Cam", imageFormat: "jpg", imageWidth: 640, imageCompressionQuality: 55 } });
    assert.deepEqual(r.bus.of("vision.summary")[0], { text: "stub vision: 5 bytes", changed: true });
    await waitFor(() => r.obs.calls.length >= 3, "more looks");
    assert.equal(r.bus.of("vision.summary").length, 1, "later captures are SAME");
    assert.ok(r.rec.msgs("warn").some((m) => /stub/.test(String(m))), "startup warning that descriptions are stubbed");
    await waitFor(() => heartbeats(r.bus).some((h) => h.state === "ready" && h.mode === "mock" && h.deps?.ollama === "n/a"), "mock heartbeat");
  } finally { await r.stop(); }
});

// @spec EYES-LOOK-005, EYES-OBS-005
test("a look that throws is logged and the loop continues; a drop during the look reconnects to OBS", async () => {
  let n = 0;
  const describe = async () => {
    n++;
    if (n === 1) throw new Error("model hiccup");
    if (n === 2) { r.obs.identified = false; throw new Error("socket dropped"); }
    return "A boss.";
  };
  const r = rig({ enabled: true, engine: "ollama" }, { createDescriber: () => describe });
  try {
    await r.start();
    await waitFor(() => r.bus.of("vision.summary").length === 1, "recovered");
    assert.equal(r.rec.msgs("warn").filter((m) => m === "look failed").length, 2);
    assert.equal(r.obs.connects, 2, "reconnected after the drop");
  } finally { await r.stop(); }
});

// @spec EYES-LOOK-003
test("the wait between looks is the interval minus the look's time, never below 500 ms", async () => {
  assert.equal(nextDelay(8000, 1000), 7000);
  assert.equal(nextDelay(8000, 7800), 500);
  assert.equal(nextDelay(8000, 9000), 500);
  assert.equal(nextDelay(300, 0), 500);
  const waits: number[] = [];
  const r = rig({ enabled: true, interval_ms: 5000 }, { sleep: async (ms: number) => { waits.push(ms); await new Promise((x) => setTimeout(x, 2)); } });
  try {
    await r.start();
    await waitFor(() => waits.length >= 2, "two waits");
    assert.ok(waits.every((w) => w >= 500 && w <= 5000), waits.join(","));
  } finally { await r.stop(); }
});

// @spec EYES-OBS-002
test("OBS unreachable at start: retries and reports degraded, then ready once it answers", async () => {
  const r = rig({ enabled: true }, {}, new FakeObs(2));
  try {
    await r.start();
    await waitFor(() => r.obs.identified, "connected after two failures", 5000);
    assert.equal(r.obs.connects, 3);
  } finally { await r.stop(); }
});

// @spec EYES-INJ-016, EYES-INJ-011, EYES-INJ-001
test("an injected image is described and answered through the shared handler, with vision disabled and no OBS", async () => {
  const r = rig({ enabled: false }, { fetch: (async () => new Response(Buffer.from("PIXELS"))) as never });
  try {
    await r.start();
    r.bus.handler!(event("inject.request", { id: "i1", target: "eyes", kind: "image", url: "http://dash:3000/uploads/abc", remember: true }) as never);
    await waitFor(() => r.bus.of("inject.result").length === 1, "inject.result");
    assert.deepEqual(r.bus.of("inject.result")[0], { id: "i1", ok: true, detail: "stub vision: 6 bytes" });
    assert.deepEqual(r.bus.of("vision.summary"), [{ text: "stub vision: 6 bytes", changed: true, injected: true, remember: true }]);
    assert.equal(r.obs.connects, 0);
  } finally { await r.stop(); }
});

// @spec EYES-HEALTH-003
test("the loop and injection share one tracked describer: a failed describe marks ollama down", async () => {
  const r = rig({ enabled: true, engine: "ollama" }, { createDescriber: () => async () => { throw new Error("model down"); } });
  try {
    await r.start();
    await waitFor(() => heartbeats(r.bus).some((h) => h.deps?.ollama === "down"), "ollama down");
  } finally { await r.stop(); }
});
