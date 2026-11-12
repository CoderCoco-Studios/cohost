import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { HealthTracker, withContainerRestarts, CRASH_LOOP_RESTARTS, type HeartbeatData, type ServiceHealth, type StackStatus } from "../src/index.js";

const hb = (over: Partial<HeartbeatData> = {}): HeartbeatData => ({
  service: "chat", instance: "i", pid: 1, version: "0", startedAt: 1000, state: "ready",
  deps: {}, mode: "live", intervalMs: 5000, ...over,
});

/** Independent monotonic and wall clocks, so a test can step the wall clock alone. */
function clocks() {
  const c = { mono: 50_000, wall: 1_700_000_000_000 };
  const tracker = new HealthTracker({ now: () => c.mono, wall: () => c.wall });
  return { c, tracker };
}

// @spec CTRL-HEALTH-008
test("ages follow the monotonic clock: a wall-clock step neither kills nor revives a service", () => {
  const { c, tracker } = clocks();
  tracker.ingest(hb());
  c.wall += 3_600_000; // the VM clock jumps an hour forward
  assert.equal(tracker.get("chat").state, "up");
  assert.equal(tracker.get("chat").lastSeenAgeMs, 0);
  c.mono += 16_000;
  assert.equal(tracker.get("chat").state, "stale");
  c.wall -= 7_200_000; // and back two hours
  assert.equal(tracker.get("chat").state, "stale");
});

// @spec CTRL-HEALTH-008
test("the default clock is performance.now, not Date.now", () => {
  const tracker = new HealthTracker();
  const dateNow = mock.method(Date, "now", () => 1_700_000_000_000);
  try {
    tracker.ingest(hb());
    dateNow.mock.mockImplementation(() => 1_700_000_000_000 + 3_600_000);
    assert.equal(tracker.get("chat").state, "up");
  } finally {
    dateNow.mock.restore();
  }
});

// @spec CTRL-HEALTH-009
test("seed: a record stamped in the future counts as received now, so it goes stale on schedule", () => {
  const { c, tracker } = clocks();
  tracker.seed([{ ts: c.wall + 60_000, data: hb() }]); // publisher clock one minute ahead
  assert.equal(tracker.get("chat").state, "up");
  assert.equal(tracker.get("chat").lastSeenAgeMs, 0);
  c.mono += 16_000;
  assert.equal(tracker.get("chat").state, "stale", "an unclamped future stamp would still look fresh");
});

// @spec CTRL-HEALTH-009
test("seed: a past record is aged by its wall-clock age on the monotonic clock", () => {
  const { c, tracker } = clocks();
  tracker.seed([{ ts: c.wall - 20_000, data: hb() }]);
  assert.equal(tracker.get("chat").state, "stale");
  assert.equal(tracker.get("chat").lastSeenAgeMs, 20_000);
  c.mono += 40_000;
  assert.equal(tracker.get("chat").state, "down");
});

// @spec CTRL-HEALTH-009
test("seed: a replayed older heartbeat still does not overwrite a newer one", () => {
  const { c, tracker } = clocks();
  tracker.seed([
    { ts: c.wall - 1000, data: hb({ detail: "new" }) },
    { ts: c.wall - 30_000, data: hb({ detail: "old" }) },
  ]);
  assert.equal(tracker.get("chat").heartbeat?.detail, "new");
});

const entry = (service: string, state: ServiceHealth["state"]): ServiceHealth => ({ service, state, restarts: 0 });
const status = (services: StackStatus["services"], ok = true): StackStatus => ({ docker: { ok }, services });

// @spec CTRL-HEALTH-010
test("withContainerRestarts: a restarting container with no heartbeat shows crash-looping, and its count is attached", () => {
  const out = withContainerRestarts(
    [entry("cortex", "unknown"), entry("voice", "up"), entry("chat", "down")],
    status([
      { service: "cortex", status: "restarting", restartCount: 4 },
      { service: "voice", status: "running", health: "healthy", restartCount: 0 },
      { service: "chat", status: "exited", exitCode: 1, restartCount: CRASH_LOOP_RESTARTS },
    ]),
  );
  assert.deepEqual(out.map((e) => [e.service, e.state, e.containerRestarts]), [
    ["cortex", "crash-looping", 4], ["voice", "up", 0], ["chat", "crash-looping", CRASH_LOOP_RESTARTS],
  ]);
});

// @spec CTRL-HEALTH-010
test("withContainerRestarts: a healthy or merely restarted service keeps its state; counts below the threshold do not loop", () => {
  const out = withContainerRestarts(
    [entry("cortex", "up"), entry("voice", "down"), entry("avatar", "degraded"), entry("eyes", "unknown")],
    status([
      { service: "cortex", status: "restarting", restartCount: 9 }, // heartbeat says up: the heartbeat wins
      { service: "voice", status: "exited", restartCount: CRASH_LOOP_RESTARTS - 1 },
      { service: "avatar", status: "restarting", restartCount: 9 },
      { service: "eyes", status: "running", restartCount: 20 }, // running: the count is history, not a loop
    ]),
  );
  assert.deepEqual(out.map((e) => e.state), ["up", "down", "degraded", "unknown"]);
  assert.deepEqual(out.map((e) => e.containerRestarts), [9, CRASH_LOOP_RESTARTS - 1, 9, 20]);
});

// @spec CTRL-HEALTH-010
test("withContainerRestarts: no Docker, or a service with no container row, leaves the snapshot unchanged", () => {
  const snap = [entry("cortex", "unknown")];
  assert.deepEqual(withContainerRestarts(snap, status([], false)), snap);
  assert.deepEqual(withContainerRestarts(snap, status([{ service: "redis", status: "running", restartCount: 3 }])), snap);
  assert.deepEqual(withContainerRestarts(snap, status([{ service: "cortex", status: "restarting" }])).map((e) => e.state), ["crash-looping"]);
});
