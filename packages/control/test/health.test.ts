import { test } from "node:test";
import assert from "node:assert/strict";
import { HealthTracker, KNOWN_SERVICES, type HeartbeatData } from "../src/index.js";

const hb = (over: Partial<HeartbeatData> = {}): HeartbeatData => ({
  service: "chat", instance: "i", pid: 1, version: "0", startedAt: 1000, state: "ready",
  deps: { twitch: "ok" }, mode: "live", intervalMs: 5000, ...over,
});

function setup() {
  const clock = { t: 1_000_000 };
  const tracker = new HealthTracker({ now: () => clock.t });
  return { clock, tracker, advance: (ms: number) => { clock.t += ms; } };
}

test("fresh ready service is up", () => {
  const { tracker, advance } = setup();
  tracker.ingest(hb());
  advance(1000);
  assert.equal(tracker.get("chat").state, "up");
});

test("stale after 3x interval, down after 10x", () => {
  const { tracker, advance } = setup();
  tracker.ingest(hb());
  advance(16_000);
  assert.equal(tracker.get("chat").state, "stale");
  advance(35_000); // 51 s
  assert.equal(tracker.get("chat").state, "down");
});

test("stopping is down immediately", () => {
  const { tracker } = setup();
  tracker.ingest(hb({ state: "stopping" }));
  assert.equal(tracker.get("chat").state, "down");
});

test("never seen is unknown, not down", () => {
  const { tracker } = setup();
  assert.equal(tracker.get("chat").state, "unknown");
  assert.equal(tracker.get("chat").heartbeat, undefined);
});

test("a dep down degrades a ready service; so does state degraded and starting", () => {
  const { tracker } = setup();
  tracker.ingest(hb({ service: "memory", deps: { postgres: "ok", ollama: "down" } }));
  assert.equal(tracker.get("memory").state, "degraded");
  tracker.ingest(hb({ service: "voice", state: "degraded", deps: {} }));
  assert.equal(tracker.get("voice").state, "degraded");
  tracker.ingest(hb({ service: "avatar", state: "starting", deps: {} }));
  assert.equal(tracker.get("avatar").state, "degraded");
  tracker.ingest(hb({ service: "avatar", state: "ready", deps: {} }));
  assert.equal(tracker.get("avatar").state, "up");
});

test("n/a deps do not degrade", () => {
  const { tracker } = setup();
  tracker.ingest(hb({ deps: { twitch: "n/a" } }));
  assert.equal(tracker.get("chat").state, "up");
});

test("uses the latest heartbeat's intervalMs", () => {
  const { tracker, advance } = setup();
  tracker.ingest(hb({ intervalMs: 1000 }));
  advance(4000);
  assert.equal(tracker.get("chat").state, "stale");
});

test("three distinct startedAt within 60 s is crash-looping, taking precedence", () => {
  const { tracker, advance } = setup();
  tracker.ingest(hb({ startedAt: 1 }));
  advance(10_000);
  tracker.ingest(hb({ startedAt: 2 }));
  advance(10_000);
  tracker.ingest(hb({ startedAt: 3, state: "ready" }));
  const s = tracker.get("chat");
  assert.equal(s.state, "crash-looping");
  assert.equal(s.restarts, 3);
  advance(40_000); // silent too: still crash-looping, not stale/down
  assert.equal(tracker.get("chat").state, "crash-looping");
});

test("crash-loop clears once fewer than 3 starts remain in the window", () => {
  const { tracker, advance } = setup();
  for (const startedAt of [1, 2, 3]) { tracker.ingest(hb({ startedAt })); advance(5000); }
  assert.equal(tracker.get("chat").state, "crash-looping");
  // keep heartbeating on the last startedAt while the window rolls over
  for (let i = 0; i < 13; i++) { advance(5000); tracker.ingest(hb({ startedAt: 3 })); }
  const s = tracker.get("chat");
  assert.equal(s.state, "up");
  assert.equal(s.restarts, 0);
});

test("repeated heartbeats with one startedAt are not restarts", () => {
  const { tracker, advance } = setup();
  for (let i = 0; i < 12; i++) { tracker.ingest(hb()); advance(5000); }
  assert.equal(tracker.get("chat").restarts, 1);
  assert.notEqual(tracker.get("chat").state, "crash-looping");
});

test("snapshot lists every known service, unseen ones as unknown", () => {
  const { tracker } = setup();
  tracker.ingest(hb({ service: "cortex", deps: { llm: "ok" } }));
  tracker.ingest(hb({ service: "extra", deps: {} }));
  const snap = tracker.snapshot();
  assert.equal(snap.length, KNOWN_SERVICES.length + 1);
  const unknown = snap.filter((s) => s.state === "unknown");
  assert.equal(unknown.length, 9);
  assert.ok(unknown.every((s) => s.heartbeat === undefined && s.restarts === 0));
  assert.equal(snap.find((s) => s.service === "cortex")!.state, "up");
  assert.ok(snap.find((s) => s.service === "extra"));
});

test("onChange fires on state transitions (including time-based ones via tick), not on identical heartbeats", () => {
  const { tracker, advance } = setup();
  const calls: string[] = [];
  tracker.onChange((snap) => calls.push(snap.find((s) => s.service === "chat")!.state));
  tracker.ingest(hb());
  tracker.ingest(hb());
  assert.deepEqual(calls, ["up"]);
  advance(16_000);
  tracker.tick();
  assert.deepEqual(calls, ["up", "stale"]);
});

test("seed() uses history timestamps as receive times", () => {
  const { tracker, clock } = setup();
  tracker.seed([{ ts: clock.t - 20_000, data: hb() }]);
  assert.equal(tracker.get("chat").state, "stale");
});
