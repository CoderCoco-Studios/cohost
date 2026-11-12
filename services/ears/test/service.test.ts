import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordingLog, testConfig, waitFor } from "@cohost/testing";
import { runService, type Heartbeat } from "@cohost/shared";
import { createEarsService } from "../src/service.js";
import { stopAll } from "../src/sources.js";

/** runService with no Redis, no signals and no process exit; `main` is the real ears main. */
async function boot(ears: Record<string, unknown>, env: Record<string, string>, startDiscord?: (d: never) => Promise<{ stop(): Promise<void> }>) {
  const order: string[] = [];
  const rec = recordingLog();
  const health: { state: string; mode: string; deps: Record<string, string>; detail?: string }[] = [];
  const subs: { group: string; types: readonly string[]; start?: string }[] = [];
  const exits: number[] = [];
  let shutdown: (() => void | Promise<void>) | undefined;
  const bus = {
    consumer: "b-1",
    publishHealth: async (d: never) => { health.push(d); return "1"; },
    resetGroup: async (g: string) => { order.push(`resetGroup:${g}`); },
    subscribe: (o: { group: string; types: readonly string[]; start?: string }) => { subs.push(o); return new Promise<void>(() => {}); },
    stop: () => { order.push("bus.stop"); },
  };
  let loads = 0;
  const svc = createEarsService({
    env,
    loadDiscord: async () => (loads++, { startDiscord: (startDiscord ?? (async () => ({ stop: async () => { order.push("session.stop"); } }))) as never }),
  });
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
  return { order, rec, health, last, subs, exits, stop, discordLoads: () => loads };
}

// @spec EARS-START-008, EARS-START-001, EARS-START-003, EARS-START-006, EARS-START-005
test("source off: one idle warning, ready in mode off, inject.request only, no Discord loaded", async () => {
  const r = await boot({ source: "off" }, {});
  try {
    await waitFor(() => r.health.some((h) => h.state === "ready"), "ready");
    assert.equal(r.last().mode, "off");
    assert.deepEqual(r.subs.map((s) => ({ g: s.group, t: [...s.types], s: s.start })), [{ g: "ears", t: ["inject.request"], s: "latest" }]);
    assert.equal(r.rec.msgs("warn").length, 1);
    assert.equal(r.discordLoads(), 0, "discord.js is not loaded");
  } finally {
    await r.stop();
  }
  assert.deepEqual(r.order, ["resetGroup:ears", "bus.stop"]);
  assert.deepEqual(r.exits, []);
});

// @spec EARS-START-008, EARS-START-002, EARS-START-007
test("no token: degraded with the missing-token detail, still subscribed to inject.request, mode live", async () => {
  const r = await boot({ source: "discord" }, {});
  try {
    await waitFor(() => r.health.some((h) => h.state === "degraded"), "degraded");
    assert.equal(r.last().detail, "EARS_DISCORD_TOKEN is not set");
    assert.equal(r.last().mode, "live");
    assert.equal(r.last().deps.discord, "down");
    assert.equal(r.subs.length, 1);
    assert.deepEqual(r.rec.msgs("error"), ["EARS_DISCORD_TOKEN is not set"]);
  } finally {
    await r.stop();
  }
  const same = await boot({ source: "discord" }, { EARS_DISCORD_TOKEN: "x", DISCORD_TOKEN: "x" });
  try {
    await waitFor(() => same.health.some((h) => h.state === "degraded"), "degraded");
    assert.match(same.last().detail ?? "", /ears needs a bot of its own/);
  } finally {
    await same.stop();
  }
});

// @spec EARS-START-004, EARS-SESS-008, EARS-SESS-009
test("discord plan: starts the session with EARS_DISCORD_TOKEN; shutdown stops the session, then the bus", async () => {
  const seen: { token: string }[] = [];
  const r = await boot({ source: "discord" }, { EARS_DISCORD_TOKEN: "ears-tok", DISCORD_TOKEN: "mouth-tok" }, async (d) => {
    seen.push(d as never);
    return { stop: async () => { r.order.push("session.stop"); } };
  });
  try {
    assert.equal(seen[0]!.token, "ears-tok");
  } finally {
    await r.stop();
  }
  assert.deepEqual(r.order, ["resetGroup:ears", "session.stop", "bus.stop"]);
});

// @spec EARS-SESS-001
test("discord plan: a login failure ends the process with status 1", async () => {
  const r = await boot({ source: "discord" }, { EARS_DISCORD_TOKEN: "t" }, async () => { throw new Error("login failed"); });
  try {
    assert.deepEqual(r.exits, [1]);
  } finally {
    await r.stop();
  }
});

// @spec EARS-STUB-002
test("stub engine: a startup warning, mode mock, stt n/a", async () => {
  const r = await boot({ source: "discord", stt_engine: "stub" }, {});
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
test("http plan: no token, no discord.js, inject.request only, ready with deps.http ok, stopped before the bus", async () => {
  const r = await boot({ source: "http", stt_engine: "stub", http: { host: "127.0.0.1", port: 0 } }, {});
  try {
    await waitFor(() => r.health.some((h) => h.state === "ready"), "ready");
    assert.equal(r.last().mode, "mock");
    assert.deepEqual(r.last().deps, { discord: "n/a", stt: "n/a", http: "ok", dir: "n/a" });
    assert.equal(r.discordLoads(), 0);
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
  const r = await boot({ source: "http", stt_engine: "stub", http: { host: "127.0.0.1", port } }, {});
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
test("dir plan: polls the directory, ready with deps.dir ok, no discord.js", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ears-svc-"));
  const r = await boot({ source: "dir", stt_engine: "stub", dir: { path: dir, poll_ms: 20 } }, {});
  try {
    await waitFor(() => r.health.some((h) => h.state === "ready"), "ready");
    assert.deepEqual(r.last().deps, { discord: "n/a", stt: "n/a", http: "n/a", dir: "ok" });
    assert.equal(r.discordLoads(), 0);
    assert.equal(r.subs.length, 1);
  } finally {
    await r.stop();
    await rm(dir, { recursive: true, force: true });
  }
  assert.deepEqual(r.order, ["resetGroup:ears", "bus.stop"]);
});

// @spec EARS-CAP-010, EARS-CAP-003
test("dir plan without a path: degraded idle naming ears.dir.path, still subscribed to inject.request", async () => {
  const r = await boot({ source: "dir", stt_engine: "stub" }, {});
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
  const r = await boot({ sources: ["http", "dir"], stt_engine: "stub", http: HTTP, dir: { path: dir, poll_ms: 20 } }, {});
  try {
    await waitFor(() => r.health.some((h) => h.state === "ready"), "ready");
    assert.deepEqual(r.last().deps, { discord: "n/a", stt: "n/a", http: "ok", dir: "ok" });
    assert.equal(r.last().mode, "mock");
    assert.equal(r.subs.length, 1);
    assert.equal(r.discordLoads(), 0);
  } finally {
    await r.stop();
    await rm(dir, { recursive: true, force: true });
  }
  assert.deepEqual(r.order, ["resetGroup:ears", "bus.stop"]);
});

// @spec EARS-SRC-002
test("ears.sources wins over the legacy ears.source, and a name repeated starts one adapter", async () => {
  const r = await boot({ source: "off", sources: ["http", "http"], stt_engine: "stub", http: HTTP }, {});
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
  const r = await boot({ sources: ["http", "dir"], stt_engine: "stub", http: HTTP }, {});
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
  const r = await boot({ sources: ["http", "dir"], stt_engine: "stub", http: { host: "127.0.0.1", port }, dir: { path: dir, poll_ms: 20 } }, {});
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
  const r = await boot({ sources: ["http", "desktop"], stt_engine: "stub", http: HTTP }, {});
  try {
    await waitFor(() => r.health.some((h) => h.state === "degraded"), "degraded");
    assert.deepEqual(r.last().deps, { discord: "n/a", stt: "n/a", http: "ok", dir: "n/a", desktop: "down" });
    assert.equal(r.last().detail, "desktop connector not connected");
    assert.equal(r.discordLoads(), 0);
  } finally {
    await r.stop();
  }
});

// @spec EARS-SRC-008
test("every enabled source a gap: shared idle plan naming each reason, still subscribed to inject.request", async () => {
  const r = await boot({ sources: ["dir", "discord"], stt_engine: "stub" }, {});
  try {
    await waitFor(() => r.health.some((h) => h.state === "degraded"), "degraded");
    assert.equal(r.last().detail, "ears.dir.path is not set; EARS_DISCORD_TOKEN is not set");
    assert.deepEqual(r.last().deps, { discord: "down", stt: "n/a", http: "n/a", dir: "down" });
    assert.equal(r.subs.length, 1);
    assert.deepEqual(r.rec.msgs("error").slice(0, 2), ["ears.dir.path is not set", "EARS_DISCORD_TOKEN is not set"]);
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
