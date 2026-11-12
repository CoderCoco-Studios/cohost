import { test } from "node:test";
import assert from "node:assert/strict";
import { HealthTracker, withContainerRestarts, withNeeds, type HeartbeatData } from "../src/index.js";

const hb = (service: string, over: Partial<HeartbeatData> = {}): HeartbeatData => ({
  service, instance: "i", pid: 1, version: "0", startedAt: 1000, state: "ready", deps: {}, mode: "live", intervalMs: 5000, ...over,
});

function setup() {
  const clock = { t: 1_000_000 };
  const tracker = new HealthTracker({ now: () => clock.t, wall: () => clock.t });
  return { clock, tracker, advance: (ms: number) => { clock.t += ms; } };
}
const entry = (tracker: HealthTracker, id: string) => tracker.snapshot().find((s) => s.service === id)!;

// @spec MOD-LIFE-001
test("a unit whose used unit was never seen lists it in needs as unknown, and its own state is untouched", () => {
  const { tracker } = setup();
  tracker.ingest(hb("salience"));
  const s = entry(tracker, "salience");
  assert.equal(s.state, "up");
  assert.deepEqual(s.needs, [{ service: "affect", state: "unknown" }, { service: "cortex", state: "unknown" }]);
});

// @spec MOD-LIFE-001
test("needs lists each used unit that is down, stale, crash-looping or unknown, and none that is up or degraded", () => {
  const { tracker, advance } = setup();
  tracker.ingest(hb("cortex"));
  tracker.ingest(hb("affect", { state: "degraded" })); // degraded does not count
  tracker.ingest(hb("salience"));
  assert.deepEqual(entry(tracker, "salience").needs, []);
  advance(16_000); // past 3x the 5 s interval: cortex is stale
  tracker.ingest(hb("affect", { state: "degraded" }));
  tracker.ingest(hb("salience"));
  const s = entry(tracker, "salience");
  assert.equal(s.state, "up");
  assert.deepEqual(s.needs, [{ service: "cortex", state: "stale" }]);
  advance(40_000); // past 10x: down
  tracker.ingest(hb("affect"));
  tracker.ingest(hb("salience"));
  assert.deepEqual(entry(tracker, "salience").needs, [{ service: "cortex", state: "down" }]);
});

// @spec MOD-LIFE-001
test("a unit with nothing in uses carries no needs; a unit with uses and every one up carries an empty list", () => {
  const { tracker } = setup();
  for (const id of ["salience", "affect", "memory", "cortex"]) tracker.ingest(hb(id));
  assert.equal("needs" in entry(tracker, "chat"), false);
  assert.deepEqual(entry(tracker, "cortex").needs, []);
});

// @spec MOD-LIFE-001
test("withNeeds recomputes from the states in the snapshot it is given, so a Compose overlay's crash-looping counts", () => {
  const { tracker } = setup();
  tracker.ingest(hb("avatar"));
  const overlaid = withContainerRestarts(tracker.snapshot(), {
    docker: { ok: true },
    services: [{ service: "voice", status: "restarting", restartCount: 4 }],
  } as never);
  assert.equal(overlaid.find((s) => s.service === "voice")!.state, "crash-looping");
  const after = withNeeds(overlaid);
  assert.deepEqual(after.find((s) => s.service === "avatar")!.needs, [{ service: "voice", state: "crash-looping" }]);
});
