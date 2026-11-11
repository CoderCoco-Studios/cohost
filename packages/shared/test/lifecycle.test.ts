import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as bus from "@cohost/bus";
import * as shared from "../src/index.js";
import { startHeartbeat, tracked } from "../src/index.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class RecBus {
  readonly consumer = "rec-1";
  sent: { state: string; deps: Record<string, string>; ts: number; detail?: string; mode: string; service: string; instance: string; pid: number; version: string; startedAt: number; intervalMs?: number }[] = [];
  fail = false;
  async publishHealth(d: Omit<RecBus["sent"][number], "ts">): Promise<string> {
    if (this.fail) throw new Error("redis down");
    this.sent.push({ ...d, ts: performance.now() });
    return "1";
  }
}

// @spec SHARED-LIFE-015
test("@cohost/shared exports the lifecycle helpers and @cohost/bus exports none of them", () => {
  for (const name of ["onShutdown", "beforeShutdown", "startHeartbeat", "tracked"]) {
    assert.equal(typeof (shared as Record<string, unknown>)[name], "function", `shared.${name}`);
    assert.equal(name in bus, false, `bus.${name} must be gone`);
  }
});

// @spec SHARED-LIFE-006
test("startHeartbeat builds the payload from its options and the process", async () => {
  const b = new RecBus();
  const h = startHeartbeat(b as never, { service: "svc", mode: "live", deps: { x: "ok" }, version: "9.9", detail: "d", intervalMs: 60_000 });
  await Promise.resolve();
  const first = b.sent[0]!;
  assert.equal(first.service, "svc");
  assert.equal(first.instance, "rec-1");
  assert.equal(first.pid, process.pid);
  assert.equal(first.version, "9.9");
  assert.equal(first.state, "starting");
  assert.equal(first.mode, "live");
  assert.equal(first.detail, "d");
  assert.equal(first.intervalMs, 60_000);
  const second = startHeartbeat(b as never, { service: "svc2", mode: "mock", deps: {}, intervalMs: 60_000 });
  await Promise.resolve();
  const other = b.sent.find((s) => s.service === "svc2")!;
  assert.equal(other.startedAt, first.startedAt, "startedAt is constant for the process");
  assert.equal(other.version, process.env.COHOST_VERSION ?? "dev");
  await h.stop(); await second.stop();
});

// @spec SHARED-LIFE-007
test("startHeartbeat publishes starting, then ready, then repeats every interval", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const b = new RecBus();
    const h = startHeartbeat(b as never, { service: "t", mode: "live", deps: {}, intervalMs: 100 });
    await Promise.resolve();
    assert.deepEqual(b.sent.map((s) => s.state), ["starting"]);
    mock.timers.tick(99);
    assert.deepEqual(b.sent.map((s) => s.state), ["starting"], "no beat before the interval");
    h.ready();
    await Promise.resolve();
    assert.deepEqual(b.sent.map((s) => s.state), ["starting", "ready"]);
    mock.timers.tick(1);
    mock.timers.tick(100);
    await Promise.resolve();
    assert.deepEqual(b.sent.map((s) => s.state), ["starting", "ready", "ready", "ready"], "ready repeats every interval");
    await h.stop();
  } finally { mock.timers.reset(); }
});

// @spec SHARED-LIFE-007
test("the interval comes from HEARTBEAT_INTERVAL_MS (floored) and falls back to 5000", async () => {
  const saved = process.env.HEARTBEAT_INTERVAL_MS;
  try {
    for (const [env, want] of [["1500.9", 1500], ["0", 5000], ["-3", 5000], ["abc", 5000], [undefined, 5000]] as const) {
      if (env === undefined) delete process.env.HEARTBEAT_INTERVAL_MS; else process.env.HEARTBEAT_INTERVAL_MS = env;
      const b = new RecBus();
      const h = startHeartbeat(b as never, { service: "t", mode: "live", deps: {} });
      await Promise.resolve();
      assert.equal(b.sent[0]!.intervalMs, want, `env ${env}`);
      await h.stop();
    }
  } finally {
    if (saved === undefined) delete process.env.HEARTBEAT_INTERVAL_MS; else process.env.HEARTBEAT_INTERVAL_MS = saved;
  }
});

// @spec SHARED-LIFE-008
test("startHeartbeat publishes immediately when a dep changes, and reports degraded", async () => {
  const b = new RecBus();
  let dep: "ok" | "down" = "ok";
  const h = startHeartbeat(b as never, { service: "t", mode: "live", deps: () => ({ x: dep }), intervalMs: 60_000 });
  try {
    h.ready();
    await sleep(20);
    const n = b.sent.length;
    dep = "down";
    await sleep(1300); // change check runs at least once a second, interval is 60 s
    const last = b.sent.at(-1)!;
    assert.ok(b.sent.length > n);
    assert.equal(last.state, "degraded");
    assert.deepEqual(last.deps, { x: "down" });
  } finally { await h.stop(); }
});

// @spec SHARED-LIFE-013
test("a standing detail survives ready() and yields to an explicit degraded detail or a dependency-down detail", async () => {
  const b = new RecBus();
  let dep: "ok" | "down" = "ok";
  const h = startHeartbeat(b as never, { service: "t", mode: "live", deps: () => ({ x: dep }), detail: "x is not probed", intervalMs: 60_000 });
  try {
    await Promise.resolve();
    assert.equal(b.sent[0]!.detail, "x is not probed", "present while starting");
    h.ready();
    await sleep(20);
    assert.equal(b.sent.at(-1)!.detail, "x is not probed");
    dep = "down";
    await sleep(1300);
    assert.equal(b.sent.at(-1)!.detail, "dependency down: x");
    h.degraded("boom");
    await sleep(20);
    assert.equal(b.sent.at(-1)!.detail, "boom");
  } finally { await h.stop(); }
});

// @spec SHARED-LIFE-014
test("setDetail replaces the standing detail and the change watcher publishes it", async () => {
  const b = new RecBus();
  const h = startHeartbeat(b as never, { service: "t", mode: "live", deps: {}, detail: "old", intervalMs: 60_000 });
  try {
    h.ready();
    await sleep(20);
    h.setDetail("paused");
    await sleep(1300);
    assert.equal(b.sent.at(-1)!.detail, "paused");
    h.setDetail(undefined);
    await sleep(1300);
    assert.equal(b.sent.at(-1)!.detail, undefined);
  } finally { await h.stop(); }
});

// @spec SHARED-LIFE-009
test("stop() publishes a single stopping heartbeat, cancels the timers and ignores later publications", async () => {
  const b = new RecBus();
  const h = startHeartbeat(b as never, { service: "t", mode: "live", deps: {}, intervalMs: 50 });
  h.ready();
  await h.stop(); await h.stop();
  h.ready(); h.degraded("late");
  const n = b.sent.length;
  assert.equal(b.sent.filter((s) => s.state === "stopping").length, 1);
  assert.equal(b.sent.at(-1)!.state, "stopping");
  await sleep(150);
  assert.equal(b.sent.length, n);
});

// @spec SHARED-LIFE-011
test("a failing publish is logged at most once per 60 s with the count since the last warning, and never throws", async () => {
  const b = new RecBus();
  b.fail = true;
  let t = 0;
  const warns: { count?: number }[] = [];
  const log = { warn: (o: { count?: number; failed?: number }) => warns.push({ count: o.failed ?? o.count }) } as never;
  const h = startHeartbeat(b as never, { service: "t", mode: "live", deps: {}, intervalMs: 60_000, log, now: () => t });
  try {
    await sleep(10);
    assert.equal(warns.length, 1, "first failure warns at once");
    h.degraded("x"); h.ready();
    await sleep(10);
    assert.equal(warns.length, 1, "no second warning within 60 s");
    t = 61_000;
    h.degraded("y");
    await sleep(10);
    assert.equal(warns.length, 2);
    assert.equal(warns[1]!.count, 3, "counts the publishes that failed since the last warning (two silent + this one)");
  } finally { await h.stop(); }
});

// @spec SHARED-LIFE-012
test("tracked() reports each call's outcome and still propagates errors", async () => {
  const seen: boolean[] = [];
  let fail = false;
  const fn = tracked(async (n: number) => { if (fail) throw new Error("x"); return n * 2; }, (ok) => seen.push(ok));
  assert.equal(await fn(2), 4);
  fail = true;
  await assert.rejects(fn(1));
  assert.deepEqual(seen, [true, false]);
});

// @spec SHARED-LIFE-010, SHARED-LIFE-001
test("SIGTERM publishes `stopping` before the service's own shutdown callback, then exits 0", () => {
  const r = spawnSync(process.execPath, ["--import", "tsx", new URL("./shutdown.fixture.ts", import.meta.url).pathname], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split("\n"), ["hb:starting", "hb:ready", "hb:stopping", "bus.stop"]);
});
