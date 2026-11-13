import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConnectorFakeBus, recordingLog, testConfig, waitFor } from "@cohost/testing";
import { runService, wavWrap, type Heartbeat } from "@cohost/shared";
import { createEarsService } from "../src/service.js";
import { stopAll } from "../src/sources.js";

/** runService with no Redis, no signals and no process exit; `main` is the real ears main. */
async function boot(ears: Record<string, unknown>, setup?: (bus: ConnectorFakeBus) => void) {
  const order: string[] = [];
  const rec = recordingLog();
  const subs: { group: string; types: readonly string[]; start?: string }[] = [];
  const exits: number[] = [];
  let shutdown: (() => void | Promise<void>) | undefined;
  const bus = Object.assign(new ConnectorFakeBus(), {
    resetGroup: async (g: string) => { order.push(`resetGroup:${g}`); },
    subscribe: (o: { group: string; types: readonly string[]; start?: string }) => { subs.push(o); return new Promise<void>(() => {}); },
  });
  const stopBus = bus.stop.bind(bus);
  bus.stop = () => { order.push("bus.stop"); stopBus(); };
  setup?.(bus);
  const health = bus.health as { state: string; mode: string; deps: Record<string, string>; detail?: string }[];
  const svc = createEarsService({ registryIntervalMs: 20, refreshMs: 20 });
  let hb: Heartbeat | undefined;
  await runService({
    service: "ears",
    health: svc.health,
    main: async (ctx) => { hb = ctx.heartbeat; await svc.main(ctx); },
    loadConfig: () => testConfig({ ears }),
    createBus: () => bus as never,
    onShutdown: (fn) => { shutdown = fn; },
    exit: (c) => { exits.push(c); },
    log: rec.log,
  });
  const last = () => health[health.length - 1]!;
  const stop = async () => { await shutdown?.(); await hb?.stop(); };
  return { order, rec, health, last, subs, exits, stop, bus };
}

// @spec EARS-START-008, EARS-START-001, EARS-START-003, EARS-START-006, EARS-START-005
test("empty sources: one idle warning, ready in mode off, inject.request only", async () => {
  const r = await boot({ sources: [] });
  try {
    await waitFor(() => r.health.some((h) => h.state === "ready"), "ready");
    assert.equal(r.last().mode, "off");
    assert.deepEqual(r.subs.map((s) => ({ g: s.group, t: [...s.types], s: s.start })), [{ g: "ears", t: ["inject.request"], s: "latest" }]);
    assert.equal(r.rec.msgs("warn").length, 1);
  } finally {
    await r.stop();
  }
  assert.deepEqual(r.order, ["resetGroup:ears", "bus.stop"]);
  assert.deepEqual(r.exits, []);
});

// @spec EARS-CON-001, EARS-CON-002, EARS-CON-005, EARS-HLTH-002, CONN-ISO-001
test("discord is a connector source: no token or Discord client is involved; it is down with no connector, ok once one registers, with no restart", async () => {
  const r = await boot({ sources: ["discord"], stt_engine: "stub", vad: { engine: "gap" } });
  try {
    await waitFor(() => r.health.some((h) => h.state === "degraded"), "degraded");
    assert.equal(r.last().deps.discord, "down");
    assert.match(r.last().detail ?? "", /discord connector not connected/);
    assert.equal(r.subs.length, 1, "inject.request is subscribed");
    assert.deepEqual(r.exits, []);
    r.bus.register("discord", [{ cap: "audio-in", tag: "discord", format: { rate: 16000, channels: 1 }, ready: true, transport: "stream" }]);
    await waitFor(() => r.last().state === "ready", "ready once the connector registers");
    assert.equal(r.last().deps.discord, "ok");
    assert.deepEqual(r.bus.tails, ["in.discord"]);
  } finally {
    await r.stop();
  }
  assert.deepEqual(r.order, ["resetGroup:ears", "bus.stop"]);
});

// @spec EARS-SRC-004, CONN-ISO-003, EARS-CON-005
test("a connector going away turns only its dependency down: http keeps running and the process stays up", async () => {
  const r = await boot({ sources: ["http", "discord"], stt_engine: "stub", vad: { engine: "gap" }, http: HTTP }, (b) => b.register("discord", [{ cap: "audio-in", tag: "discord", format: { rate: 16000, channels: 1 }, ready: true, transport: "stream" }]));
  try {
    await waitFor(() => r.last().state === "ready", "ready");
    r.bus.regs.delete("discord");
    await waitFor(() => r.last().deps.discord === "down", "discord down");
    assert.equal(r.last().deps.http, "ok");
    assert.deepEqual(r.exits, []);
  } finally {
    await r.stop();
  }
});

// @spec EARS-SRC-009, EARS-SRC-012, CONN-DESK-003
test("a desktop registration with transport http binds the listener without http enabled, and desktop is ok while it is bound and the registration is ready", async () => {
  const r = await boot({ sources: ["desktop"], stt_engine: "stub", http: HTTP }, (b) => b.register("desktop", [{ cap: "audio-in", tag: "desktop", format: { rate: 16000, channels: 1 }, ready: true, transport: "http" }]));
  try {
    await waitFor(() => r.last().state === "ready", "ready");
    assert.deepEqual(r.last().deps, { discord: "n/a", stt: "n/a", http: "n/a", dir: "n/a", desktop: "ok" });
    assert.deepEqual(r.bus.tails, [], "no stream is read for an http tag");
    r.bus.regs.delete("desktop");
    await waitFor(() => r.last().deps.desktop === "down", "down when the registration lapses");
    r.bus.register("desktop", [{ cap: "audio-in", tag: "desktop", format: { rate: 16000, channels: 1 }, ready: true, transport: "http" }]);
    await waitFor(() => r.last().deps.desktop === "ok", "ok again without a restart");
    // @spec EARS-SRC-010
    const port = (r.rec.lines.find((l) => /http listening/.test(String(l.msg)))!.obj as { port: number }).port;
    const post = (q: string, path = "/audio") => fetch(`http://127.0.0.1:${port}${path}${q}`, { method: "POST", body: wavWrap(Buffer.alloc(32000), 16000, 1), headers: { "content-type": "audio/wav" } });
    assert.equal((await post("?source=desktop")).status, 200, "an enabled source whose registration says http");
    assert.equal((await post("?source=discord")).status, 400, "a tag that is not an enabled http source");
    assert.equal((await post("?source=nobody")).status, 400);
    assert.equal((r.bus.published.at(-1)!.data as { source?: string }).source, "desktop");
  } finally {
    await r.stop();
  }
});

// @spec EARS-STUB-002
test("stub engine: a startup warning, mode mock, stt n/a", async () => {
  const r = await boot({ sources: ["discord"], stt_engine: "stub", vad: { engine: "gap" } });
  try {
    await waitFor(() => r.health.some((h) => h.state === "degraded"), "degraded");
    assert.equal(r.last().mode, "mock");
    assert.equal(r.last().deps.stt, "n/a");
    assert.ok(r.rec.msgs("warn").some((m) => /stub/i.test(String(m))));
  } finally {
    await r.stop();
  }
});

// @spec EARS-CAP-003, EARS-CAP-007, EARS-CAP-011, EARS-CAP-012
test("http plan: inject.request only, ready with deps.http ok, stopped before the bus", async () => {
  const r = await boot({ sources: ["http"], stt_engine: "stub", http: { host: "127.0.0.1", port: 0 } });
  try {
    await waitFor(() => r.health.some((h) => h.state === "ready"), "ready");
    assert.equal(r.last().mode, "mock");
    assert.deepEqual(r.last().deps, { discord: "n/a", stt: "n/a", http: "ok", dir: "n/a" });
    assert.deepEqual(r.subs.map((s) => ({ g: s.group, t: [...s.types], s: s.start })), [{ g: "ears", t: ["inject.request"], s: "latest" }]);
  } finally {
    await r.stop();
  }
  assert.deepEqual(r.order, ["resetGroup:ears", "bus.stop"]);
  assert.deepEqual(r.exits, []);
});

// @spec EARS-CAP-007
test("http plan: a port already in use leaves the process up, degraded, deps.http down", async () => {
  const blocker = createServer();
  await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const port = (blocker.address() as { port: number }).port;
  const r = await boot({ sources: ["http"], stt_engine: "stub", http: { host: "127.0.0.1", port } });
  try {
    await waitFor(() => r.health.some((h) => h.state === "degraded"), "degraded");
    assert.equal(r.last().deps.http, "down");
    assert.match(r.last().detail ?? "", /EADDRINUSE/);
    assert.deepEqual(r.exits, []);
  } finally {
    await r.stop();
    await new Promise((resolve) => blocker.close(resolve));
  }
});

// @spec EARS-CAP-003, EARS-CAP-008, EARS-CAP-011
test("dir plan: polls the directory, ready with deps.dir ok", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ears-svc-"));
  const r = await boot({ sources: ["dir"], stt_engine: "stub", dir: { path: dir, poll_ms: 20 } });
  try {
    await waitFor(() => r.health.some((h) => h.state === "ready"), "ready");
    assert.deepEqual(r.last().deps, { discord: "n/a", stt: "n/a", http: "n/a", dir: "ok" });
    assert.equal(r.subs.length, 1);
  } finally {
    await r.stop();
    await rm(dir, { recursive: true, force: true });
  }
  assert.deepEqual(r.order, ["resetGroup:ears", "bus.stop"]);
});

// @spec EARS-CAP-010, EARS-CAP-003
test("dir plan without a path: degraded idle naming ears.dir.path, still subscribed to inject.request", async () => {
  const r = await boot({ sources: ["dir"], stt_engine: "stub" });
  try {
    await waitFor(() => r.health.some((h) => h.state === "degraded"), "degraded");
    assert.equal(r.last().detail, "ears.dir.path is not set");
    assert.equal(r.last().deps.dir, "down");
    assert.equal(r.subs.length, 1);
    assert.deepEqual(r.rec.msgs("error"), ["ears.dir.path is not set"]);
    assert.deepEqual(r.exits, []);
  } finally {
    await r.stop();
  }
});

const HTTP = { host: "127.0.0.1", port: 0 };

// @spec EARS-SRC-001, EARS-SRC-005, EARS-SRC-008
test("http and dir together: both start, both ok, one inject.request subscription, one shutdown", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ears-multi-"));
  const r = await boot({ sources: ["http", "dir"], stt_engine: "stub", http: HTTP, dir: { path: dir, poll_ms: 20 } });
  try {
    await waitFor(() => r.health.some((h) => h.state === "ready"), "ready");
    assert.deepEqual(r.last().deps, { discord: "n/a", stt: "n/a", http: "ok", dir: "ok" });
    assert.equal(r.last().mode, "mock");
    assert.equal(r.subs.length, 1);
  } finally {
    await r.stop();
    await rm(dir, { recursive: true, force: true });
  }
  assert.deepEqual(r.order, ["resetGroup:ears", "bus.stop"]);
});

// @spec EARS-SRC-002
test("a source name repeated in ears.sources starts one adapter", async () => {
  const r = await boot({ sources: ["http", "http"], stt_engine: "stub", http: HTTP });
  try {
    await waitFor(() => r.health.some((h) => h.state === "ready"), "ready");
    assert.equal(r.last().mode, "mock");
    assert.equal(r.last().deps.http, "ok");
    assert.equal(r.rec.msgs("info").filter((m) => /http listening/.test(String(m))).length, 1);
  } finally {
    await r.stop();
  }
});

// @spec EARS-SRC-003, EARS-SRC-004, EARS-SRC-005
test("a gap source (dir with no path) is down and logged while http keeps running; the process stays up, degraded", async () => {
  const r = await boot({ sources: ["http", "dir"], stt_engine: "stub", http: HTTP });
  try {
    await waitFor(() => r.health.some((h) => h.state === "degraded"), "degraded");
    assert.deepEqual(r.last().deps, { discord: "n/a", stt: "n/a", http: "ok", dir: "down" });
    assert.match(r.last().detail ?? "", /ears\.dir\.path is not set/);
    assert.deepEqual(r.rec.msgs("error"), ["ears.dir.path is not set"]);
    assert.deepEqual(r.exits, []);
    assert.equal(r.subs.length, 1);
  } finally {
    await r.stop();
  }
});

// @spec EARS-SRC-004
test("a source that cannot start (port in use) is down while dir keeps running and shutdown still stops everything", async () => {
  const blocker = createServer();
  await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const port = (blocker.address() as { port: number }).port;
  const dir = await mkdtemp(join(tmpdir(), "ears-multi-"));
  const r = await boot({ sources: ["http", "dir"], stt_engine: "stub", http: { host: "127.0.0.1", port }, dir: { path: dir, poll_ms: 20 } });
  try {
    await waitFor(() => r.health.some((h) => h.state === "degraded"), "degraded");
    assert.deepEqual(r.last().deps, { discord: "n/a", stt: "n/a", http: "down", dir: "ok" });
    assert.match(r.last().detail ?? "", /EADDRINUSE/);
    assert.deepEqual(r.exits, []);
  } finally {
    await r.stop();
    await new Promise((resolve) => blocker.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
  assert.deepEqual(r.order, ["resetGroup:ears", "bus.stop"]);
});

// @spec EARS-SRC-004, EARS-SRC-005
test("a connector source tag with no connector is down with its own dep and detail; http keeps running", async () => {
  const r = await boot({ sources: ["http", "desktop"], stt_engine: "stub", vad: { engine: "gap" }, http: HTTP });
  try {
    await waitFor(() => r.health.some((h) => h.state === "degraded"), "degraded");
    assert.deepEqual(r.last().deps, { discord: "n/a", stt: "n/a", http: "ok", dir: "n/a", desktop: "down" });
    assert.match(r.last().detail ?? "", /^desktop connector not connected/);
  } finally {
    await r.stop();
  }
});

// @spec EARS-SRC-008
test("every enabled source a gap: shared idle plan naming each reason, still subscribed to inject.request", async () => {
  const r = await boot({ sources: ["dir"], stt_engine: "stub" });
  try {
    await waitFor(() => r.health.some((h) => h.state === "degraded"), "degraded");
    assert.equal(r.last().detail, "ears.dir.path is not set");
    assert.deepEqual(r.last().deps, { discord: "n/a", stt: "n/a", http: "n/a", dir: "down" });
    assert.equal(r.subs.length, 1);
  } finally {
    await r.stop();
  }
});

// @spec EARS-SRC-004
test("stopAll stops every source even when one stop() throws, and says which", async () => {
  const rec = recordingLog();
  const stopped: string[] = [];
  const mk = (name: string, fail = false) => ({ name, start: async () => {}, status: () => "ok" as const, stop: async () => { stopped.push(name); if (fail) throw new Error("boom"); } });
  await stopAll([mk("a"), mk("b", true), mk("c")], rec.log);
  assert.deepEqual(stopped.sort(), ["a", "b", "c"]);
  assert.equal(rec.msgs("error").length, 1);
});
