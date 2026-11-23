import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { FakeBus, event, recordingLog, testConfig, waitFor } from "@cohost/testing";
import { runService } from "@cohost/shared";
import { eyesService, nextDelay, type ObsClient } from "../src/service.js";
import { JPEG_B64, JPEG_BYTES, serveModel } from "./support.js";

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
    ...deps,
  });
  const { llm, ...vision } = over as { llm?: Record<string, unknown> };
  const cfg = testConfig({ ...(llm ? { llm } : {}), vision: { model: "v", provider: "stub", interval_ms: 1000, ...vision } });
  const start = () => runService({
    service: "eyes", health: () => svc.health(cfg), main: async (ctx) => { heartbeat = ctx.heartbeat; await svc.main(ctx); },
    loadConfig: () => cfg, createBus: () => bus as never, log: rec.log,
    onShutdown: (fn) => { shutdown = fn; }, exit: (c) => { exits.push(c); },
  });
  return { bus, rec, obs, exits, start, stop: async () => { await shutdown?.(); await heartbeat?.stop(); } };
}
const heartbeats = (b: SvcBus) => b.health;

// @spec EYES-ENAB-001, EYES-ENAB-002, EYES-ENAB-004, EYES-HEALTH-001, EYES-HEALTH-005
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

// @spec EYES-ENAB-003, EYES-OBS-001, EYES-OBS-006, EYES-LOOK-001, EYES-LOOK-006, EYES-STUB-001, EYES-STUB-002
test("enabled with the stub engine: OBS connects, the screenshot uses the configured width and quality, one stub summary is published, mode is mock", async () => {
  const r = rig({ enabled: true, jpeg_quality: 55, obs: { host: "obs.local", port: 4456, source: "Cam", width: 640, password: "pw" } });
  try {
    await r.start();
    await waitFor(() => r.bus.of("vision.summary").length === 1, "summary");
    assert.equal(r.obs.url, "ws://obs.local:4456");
    assert.deepEqual(r.obs.calls[0], { request: "GetSourceScreenshot", args: { sourceName: "Cam", imageFormat: "jpg", imageWidth: 640, imageCompressionQuality: 55 } });
    const { timing, ...summary } = r.bus.of("vision.summary")[0]!;
    assert.deepEqual(summary, { text: "stub vision: 5 bytes", changed: true });
    assert.ok(timing && Number.isInteger(timing.capturedAt) && Number.isInteger(timing.describedAt), "EYES-LOOK-006: epoch stamps");
    await waitFor(() => r.obs.calls.length >= 3, "more looks");
    assert.equal(r.bus.of("vision.summary").length, 1, "later captures are SAME");
    assert.ok(r.rec.msgs("warn").some((m) => /stub/.test(String(m))), "startup warning that descriptions are stubbed");
    await waitFor(() => heartbeats(r.bus).some((h) => h.state === "ready" && h.mode === "mock" && h.deps?.vision === "n/a"), "mock heartbeat");
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
  const r = rig({ enabled: true, provider: "ollama" }, { createDescriber: () => describe });
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

// @spec EYES-OBS-002, EYES-HEALTH-005
test("OBS unreachable at start: retries and reports degraded, then ready once it answers", async () => {
  const r = rig({ enabled: true }, {}, new FakeObs(2));
  try {
    await r.start();
    await waitFor(() => r.obs.identified, "connected after two failures", 5000);
    assert.equal(r.obs.connects, 3);
    await waitFor(() => heartbeats(r.bus).some((h) => h.state === "ready" && h.mode !== "off" && h.deps?.obs === "ok"), "ready once OBS answers");
    const states = heartbeats(r.bus).map((h) => h.state);
    assert.ok(states.includes("degraded"), `degraded while unreachable: ${states}`);
    assert.ok(states.indexOf("degraded") < states.lastIndexOf("ready"), `degraded before ready: ${states}`);
  } finally { await r.stop(); }
});

// @spec EYES-INJ-016, EYES-INJ-011, EYES-INJ-001
test("an injected image is described and answered through the shared handler, with vision disabled and no OBS", async () => {
  const r = rig({ enabled: false });
  r.bus.takeUpload = async () => Buffer.from("PIXELS");
  try {
    await r.start();
    r.bus.handler!(event("inject.request", { id: "i1", target: "eyes", kind: "image", uploadId: "0123456789abcdef0123456789abcdef", contentType: "image/png", remember: true }) as never);
    await waitFor(() => r.bus.of("inject.result").length === 1, "inject.result");
    assert.deepEqual(r.bus.of("inject.result")[0], { id: "i1", ok: true, detail: "stub vision: 6 bytes" });
    assert.deepEqual(r.bus.of("vision.summary"), [{ text: "stub vision: 6 bytes", changed: true, injected: true, remember: true }]);
    assert.equal(r.obs.connects, 0);
  } finally { await r.stop(); }
});

// @spec EYES-HEALTH-003
test("the loop and injection share one tracked describer: a failed describe marks vision down", async () => {
  const r = rig({ enabled: true, provider: "ollama" }, { createDescriber: () => async () => { throw new Error("model down"); } });
  try {
    await r.start();
    await waitFor(() => heartbeats(r.bus).some((h) => h.deps?.vision === "down"), "vision down");
  } finally { await r.stop(); }
});

// @spec EYES-LOOK-004
test("connected to the socket but not identified: no screenshot is requested and no 'look failed' is logged", async () => {
  class UnidentifiedObs extends FakeObs {
    override async connect(url: string): Promise<{ obsWebSocketVersion: string }> { this.connects++; this.url = url; return { obsWebSocketVersion: "5.1.0" }; }
  }
  const obs = new UnidentifiedObs();
  let sleeps = 0;
  const r = rig({ enabled: true }, { sleep: async () => { sleeps++; await new Promise((x) => setTimeout(x, 2)); } }, obs);
  try {
    await r.start();
    await waitFor(() => sleeps >= 5, "several loop passes");
    assert.equal(obs.connects, 1, "the loop does not reconnect on a skipped look");
    assert.equal(obs.identified, false);
    assert.deepEqual(obs.calls, []);
    assert.equal(r.rec.msgs("warn").filter((m) => m === "look failed").length, 0);
    assert.equal(r.rec.msgs("error").length, 0);
  } finally { await r.stop(); }
});

// ---- the describer's provider (#189)

/** An OBS that identifies and returns a real JPEG, so a hosted provider's image check passes. */
class JpegObs extends FakeObs {
  override async call(request: string, args: Record<string, unknown>): Promise<{ imageData: string }> {
    this.calls.push({ request, args });
    return { imageData: `data:image/jpeg;base64,${JPEG_B64}` };
  }
}
/** An OBS that connects and never identifies, so the loop takes no look: only injected images reach the describer. */
class IdleObs extends FakeObs {
  override async connect(url: string): Promise<{ obsWebSocketVersion: string }> { this.connects++; this.url = url; return { obsWebSocketVersion: "5.1.0" }; }
}
const UP = "0123456789abcdef0123456789abcdef";
/** Hands an image upload to the service's inject subscription. */
function inject(r: ReturnType<typeof rig>, id = "i1"): void {
  r.bus.takeUpload = async () => JPEG_BYTES;
  r.bus.handler!(event("inject.request", { id, target: "eyes", kind: "image", uploadId: UP, contentType: "image/jpeg", remember: false }) as never);
}
const results = (r: ReturnType<typeof rig>) => r.bus.of("inject.result");
const lineText = (l: { obj: unknown; msg?: string }): string => `${l.msg ?? ""} ${typeof l.obj === "string" ? l.obj : JSON.stringify(l.obj)}`;
const warnings = (r: ReturnType<typeof rig>): string[] => r.rec.lines.filter((l) => l.level === "warn").map(lineText);
const lastHeartbeat = (r: ReturnType<typeof rig>) => heartbeats(r.bus).at(-1);
/**
 * The newest heartbeat is degraded, with vision down and the gap reason as its detail. A `ready()` after the gap was set
 * would clear the detail (SHARED-LIFE), so this fails if the OBS link reports ready without the gap reason re-applied.
 */
const degradedWithReason = (r: ReturnType<typeof rig>, reason: RegExp): boolean => {
  const h = lastHeartbeat(r);
  return h?.state === "degraded" && h.deps?.vision === "down" && reason.test(h.detail ?? "");
};
/** Run `fn` with `OLLAMA_URL` set. */
async function withOllama<T>(url: string, fn: () => Promise<T>): Promise<T> {
  const saved = process.env.OLLAMA_URL;
  process.env.OLLAMA_URL = url;
  try { return await fn(); } finally { if (saved === undefined) delete process.env.OLLAMA_URL; else process.env.OLLAMA_URL = saved; }
}
const settle = (ms: number) => new Promise((x) => setTimeout(x, ms));

// @spec EYES-PROV-003, EYES-INJ-018, EYES-PROV-002, EYES-PROV-004, EYES-HEALTH-007
test("vision disabled: an injected image is still described through vision.provider (openai at llm.openai.base_url), and deps.vision stays n/a", async () => {
  const m = await serveModel("A menu screen.");
  const r = rig({ enabled: false, provider: "openai", model: "vision-model", llm: { openai: { base_url: m.url, api_key: "sk-chat" } } });
  try {
    await r.start();
    inject(r);
    await waitFor(() => results(r).length === 1, "inject.result");
    assert.deepEqual(results(r)[0], { id: "i1", ok: true, detail: "A menu screen." });
    assert.equal(m.seen.length, 1);
    assert.equal(m.seen[0]!.url, "/chat/completions");
    assert.equal(m.seen[0]!.body.model, "vision-model");
    assert.deepEqual(r.bus.of("vision.summary"), [{ text: "A menu screen.", changed: true, injected: true, remember: false }]);
    assert.equal(r.obs.connects, 0);
    assert.ok(heartbeats(r.bus).every((h) => h.deps?.vision === "n/a"));
  } finally { await r.stop(); }
});

// @spec EYES-HEALTH-007, EYES-INJ-018
test("vision disabled: a failing injected image answers ok:false and leaves deps.vision n/a", async () => {
  const m = await serveModel();
  m.state.status = 503;
  const r = rig({ enabled: false, provider: "openai", model: "vision-model", llm: { openai: { base_url: m.url } } });
  try {
    await r.start();
    inject(r);
    await waitFor(() => results(r).length === 1, "inject.result");
    assert.equal(results(r)[0]!.ok, false);
    assert.match(results(r)[0]!.detail!, /503/);
    await settle(1300);
    assert.ok(heartbeats(r.bus).every((h) => h.deps?.vision === "n/a"));
  } finally { await r.stop(); }
});

// @spec EYES-PROV-006, EYES-PROV-007, EYES-HEALTH-003
test("enabled: a 400 for one injected frame leaves deps.vision ok, a 503 sets it down, and a later success sets it ok again", async () => {
  const m = await serveModel();
  const r = rig({ enabled: true, provider: "openai", model: "vision-model", llm: { openai: { base_url: m.url } } }, {}, new IdleObs());
  try {
    await r.start();
    m.state.status = 400;
    inject(r, "i1");
    await waitFor(() => results(r).length === 1, "400 result");
    assert.equal(results(r)[0]!.ok, false);
    assert.match(results(r)[0]!.detail!, /openai chat 400/);
    await settle(1300);
    assert.ok(heartbeats(r.bus).every((h) => h.deps?.vision !== "down"), "a 400 does not mark vision down");

    m.state.status = 503;
    inject(r, "i2");
    await waitFor(() => results(r).length === 2, "503 result");
    await waitFor(() => heartbeats(r.bus).some((h) => h.deps?.vision === "down"), "vision down", 4000);

    m.state.status = 200;
    inject(r, "i3");
    await waitFor(() => results(r).length === 3 && results(r)[2]!.ok === true, "success result");
    await waitFor(() => lastHeartbeat(r)?.deps?.vision === "ok", "vision ok again", 4000);
  } finally { await r.stop(); }
});

// @spec EYES-GAP-001, EYES-GAP-002, EYES-GAP-005
test("enabled with a blank vision.model: eyes stays up, the loop sends no describe request, and deps.vision is down with `vision.model is not set`", async () => {
  const m = await serveModel();
  let sleeps = 0;
  await withOllama(m.url, async () => {
    const r = rig({ enabled: true, provider: "ollama", model: "" }, { sleep: async () => { sleeps++; await settle(2); } }, new JpegObs());
    try {
      await r.start();
      await waitFor(() => r.obs.connects >= 1 && sleeps >= 5, "OBS connected and several loop passes");
      assert.deepEqual(m.seen, []);
      assert.deepEqual(r.exits, []);
      await waitFor(() => degradedWithReason(r, /vision\.model is not set/), "last heartbeat degraded with the reason", 4000);
    } finally { await r.stop(); }
  });
});

// @spec EYES-GAP-003, EYES-GAP-005
test("enabled, anthropic without llm.claude.api_key: eyes stays up, each look fails at once, deps.vision is down with the reason, injection answers ok:false", async () => {
  const r = rig({ enabled: true, provider: "anthropic", model: "claude-vision" }, {}, new JpegObs());
  try {
    await r.start();
    await waitFor(() => r.obs.connects >= 1 && r.rec.msgs("warn").filter((m) => m === "look failed").length >= 1, "OBS connected and a look failed");
    assert.ok(r.rec.lines.some((l) => l.level === "warn" && /not configured: llm\.claude\.api_key is not set/.test(lineText(l))));
    await waitFor(() => degradedWithReason(r, /llm\.claude\.api_key is not set/), "last heartbeat degraded with the reason", 4000);
    inject(r);
    await waitFor(() => results(r).length === 1, "inject.result");
    assert.equal(results(r)[0]!.ok, false);
    assert.match(results(r)[0]!.detail!, /llm\.claude\.api_key is not set/);
    assert.equal(r.bus.of("vision.summary").length, 0);
    assert.deepEqual(r.exits, []);
  } finally { await r.stop(); }
});

// @spec EYES-GAP-003
test("enabled, bedrock without its region and keys: deps.vision is down naming the missing llm.bedrock key", async () => {
  const r = rig({ enabled: true, provider: "bedrock", model: "claude-vision" }, {}, new JpegObs());
  try {
    await r.start();
    await waitFor(() => r.obs.connects >= 1, "OBS connected");
    await waitFor(() => degradedWithReason(r, /llm\.bedrock\.region/), "last heartbeat degraded with the reason", 4000);
    assert.deepEqual(r.exits, []);
  } finally { await r.stop(); }
});

// @spec EYES-GAP-004, EYES-GAP-005
test("disabled with a blank vision.model: eyes stays up and answers every injected image ok:false `vision.model is not set`, with no request and no summary", async () => {
  const m = await serveModel();
  await withOllama(m.url, async () => {
    const r = rig({ enabled: false, provider: "ollama", model: "" });
    try {
      await r.start();
      inject(r, "i1");
      inject(r, "i2");
      await waitFor(() => results(r).length === 2, "two results");
      assert.deepEqual(results(r), [{ id: "i1", ok: false, detail: "vision.model is not set" }, { id: "i2", ok: false, detail: "vision.model is not set" }]);
      assert.equal(r.bus.of("vision.summary").length, 0);
      assert.deepEqual(m.seen, []);
      assert.deepEqual(r.exits, []);
    } finally { await r.stop(); }
  });
});

// @spec EYES-EGR-001, EYES-EGR-003, EYES-EGR-004
test("openai at its hosted default base_url: one egress warning naming the provider and api.openai.com at start, enabled or not, and the heartbeat detail names both", async () => {
  for (const enabled of [false, true]) {
    const r = rig({ enabled, provider: "openai", model: "gpt-vision" }, {}, new IdleObs());
    try {
      await r.start();
      await settle(80);
      const egress = warnings(r).filter((w) => /api\.openai\.com/.test(w));
      assert.equal(egress.length, 1, `enabled ${enabled}: one warning`);
      assert.match(egress[0]!, /openai/);
      await waitFor(() => heartbeats(r.bus).some((h) => /openai/.test(h.detail ?? "") && /api\.openai\.com/.test(h.detail ?? "")), "heartbeat detail", 4000);
    } finally { await r.stop(); }
  }
});

// @spec EYES-EGR-002, EYES-EGR-001, EYES-EGR-004
test("anthropic and bedrock: the egress warning and the heartbeat detail name the provider and no host", async () => {
  const llm = { claude: { api_key: "sk-ant" }, bedrock: { region: "us-east-1", access_key_id: "AKIA", secret_access_key: "s" } };
  for (const provider of ["anthropic", "bedrock"]) {
    const r = rig({ enabled: false, provider, model: "claude-vision", llm });
    try {
      await r.start();
      await settle(80);
      const egress = warnings(r).filter((w) => w.includes(provider));
      assert.equal(egress.length, 1, `${provider}: one warning`);
      assert.doesNotMatch(egress[0]!, /:\/\/|\.(com|ai|net|aws)\b/);
      await waitFor(() => heartbeats(r.bus).some((h) => (h.detail ?? "").includes(provider)), "heartbeat detail", 4000);
      const detail = heartbeats(r.bus).map((h) => h.detail ?? "").find((d) => d.includes(provider))!;
      assert.doesNotMatch(detail, /:\/\/|\.(com|ai|net|aws)\b/);
    } finally { await r.stop(); }
  }
});

// @spec EYES-EGR-001, EYES-EGR-004
test("ollama on the LAN logs no egress warning, and the heartbeat detail still names the provider and its host", async () => {
  await withOllama("http://127.0.0.1:11434", async () => {
    const r = rig({ enabled: false, provider: "ollama", model: "llava" });
    try {
      await r.start();
      await settle(80);
      assert.equal(warnings(r).length, 1, "only the idle warning");
      await waitFor(() => heartbeats(r.bus).some((h) => /ollama/.test(h.detail ?? "") && /127\.0\.0\.1/.test(h.detail ?? "")), "heartbeat detail", 4000);
    } finally { await r.stop(); }
  });
});

// @spec EYES-STUB-002, EYES-EGR-001
test("the stub provider names no destination: no egress warning and no host in the heartbeat detail", async () => {
  const r = rig({ enabled: false, provider: "stub" });
  try {
    await r.start();
    await settle(80);
    assert.ok(warnings(r).every((w) => !/openai|anthropic|bedrock|ollama|:\/\//i.test(w)), warnings(r).join("|"));
    assert.ok(heartbeats(r.bus).every((h) => !/:\/\/|127\.0\.0\.1|api\./.test(h.detail ?? "")));
  } finally { await r.stop(); }
});

// @spec EYES-GAP-006, EYES-GAP-005
test("enabled, bedrock with a region and only the access key: eyes stays up, deps.vision is down with the model layer's reason, and injection answers ok:false", async () => {
  const llm = { bedrock: { region: "us-east-1", access_key_id: "AKIA" } };
  const r = rig({ enabled: true, provider: "bedrock", model: "claude-vision", llm }, {}, new JpegObs());
  try {
    await r.start();
    await waitFor(() => r.obs.connects >= 1, "OBS connected");
    await waitFor(() => degradedWithReason(r, /must be set together/), "last heartbeat degraded with the reason", 4000);
    inject(r);
    await waitFor(() => results(r).length === 1, "inject.result");
    assert.equal(results(r)[0]!.ok, false);
    assert.match(results(r)[0]!.detail!, /must be set together/);
    assert.deepEqual(r.exits, []);
  } finally { await r.stop(); }
});

// @spec EYES-PROV-007, EYES-HEALTH-003
test("enabled with openai: an injected BMP is a frame fault, answers ok:false, and deps.vision never goes down", async () => {
  const m = await serveModel();
  const r = rig({ enabled: true, provider: "openai", model: "vision-model", llm: { openai: { base_url: m.url } } }, {}, new IdleObs());
  try {
    await r.start();
    r.bus.takeUpload = async () => Buffer.from("BM\x36\x00\x00\x00\x00\x00\x00\x00\x36\x00\x00\x00", "latin1");
    r.bus.handler!(event("inject.request", { id: "i1", target: "eyes", kind: "image", uploadId: UP, contentType: "image/bmp", remember: false }) as never);
    await waitFor(() => results(r).length === 1, "inject.result");
    assert.equal(results(r)[0]!.ok, false);
    assert.match(results(r)[0]!.detail!, /not JPEG, PNG, GIF or WebP/);
    await settle(1300);
    assert.ok(heartbeats(r.bus).every((h) => h.deps?.vision !== "down"));
    assert.deepEqual(m.seen, []);
  } finally { await r.stop(); }
});

// @spec EYES-PROV-006, EYES-HEALTH-003
test("enabled with openai: a socket dropped mid-body is an outage, a TypeError from undici, so deps.vision goes down", async () => {
  const m = await serveModel();
  m.state.dropMidBody = true;
  const r = rig({ enabled: true, provider: "openai", model: "vision-model", llm: { openai: { base_url: m.url } } }, {}, new IdleObs());
  try {
    await r.start();
    inject(r, "i1");
    await waitFor(() => results(r).length === 1, "inject.result");
    assert.equal(results(r)[0]!.ok, false);
    await waitFor(() => heartbeats(r.bus).some((h) => h.deps?.vision === "down"), "vision down after a dropped socket", 4000);
  } finally { await r.stop(); }
});
