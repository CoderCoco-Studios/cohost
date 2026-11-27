import { test } from "node:test";
import assert from "node:assert/strict";
import { WAITING_FOR_CREDENTIALS } from "@cohost/shared";
import { recordingLog } from "@cohost/testing";
import { Redeliverer, type Redeliver } from "../src/deliver.js";

// The dashboard's credentials re-delivery (settings-store STORE-DLV-005), driven through its own seams: the heartbeats it
// observes, the action slot it claims and the control plane's delivery it calls.

const waiting = (service: string) => ({ service, state: "starting", detail: WAITING_FOR_CREDENTIALS });
const ready = (service: string) => ({ service, state: "ready" });

function rig(o: { deliver?: (w: string[]) => string[]; held?: () => boolean } = {}) {
  const calls: { waiting: string[]; ready: string[] }[] = [];
  const gates: (() => void)[] = [];
  let hold = false;
  const redeliver: Redeliver = async (s) => {
    calls.push({ waiting: [...s.waiting].toSorted(), ready: [...s.ready].toSorted() });
    if (hold) await new Promise<void>((r) => gates.push(r));
    return { delivered: (o.deliver ?? ((w) => w))([...s.waiting]), failures: [] };
  };
  const acquired: string[] = [];
  let released = 0;
  const acquire = (kind: string) => {
    if (o.held?.()) return undefined;
    acquired.push(kind);
    return () => { released++; };
  };
  const rec = recordingLog();
  let clock = 0;
  const r = new Redeliverer({ redeliver, acquire, log: rec.log, now: () => ++clock });
  return { r, calls, rec, acquired, released: () => released, holdNext: () => { hold = true; }, openAll: () => { hold = false; for (const g of gates.splice(0)) g(); } };
}

// @spec STORE-DLV-005
test("the first run waits for start: seeded heartbeats ask for nothing, then one delivery sees every unit's newest heartbeat", async () => {
  const t = rig();
  t.r.observe(waiting("cortex"));
  t.r.observe(ready("voice"));
  t.r.observe({ service: "memory", state: "degraded" });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(t.calls, [], "nothing runs before start");
  await t.r.start();
  assert.deepEqual(t.calls, [{ waiting: ["cortex"], ready: ["memory", "voice"] }]);
  assert.deepEqual(t.acquired, ["deliver"], "the run holds the stack slot as \"deliver\"");
  assert.equal(t.released(), 1);
  assert.ok(t.rec.lines.some((l) => l.level === "info" && l.msg === "delivered credentials to cortex"));
});

// @spec STORE-DLV-005
test("a unit counts as waiting only for a waiting heartbeat received after its last delivery: one delivery per container start", async () => {
  const t = rig();
  await t.r.start();
  t.r.observe(waiting("cortex"));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(t.calls.at(-1), { waiting: ["cortex"], ready: [] });
  const n = t.calls.length;
  // The same unit's heartbeat from before the delivery is not a new wait: a stack probe change runs with nobody waiting.
  await t.r.run();
  assert.deepEqual(t.calls.at(-1), { waiting: [], ready: [] });
  assert.equal(t.calls.length, n + 1);
  // A new waiting heartbeat (the container restarted) asks for a delivery again.
  t.r.observe(waiting("cortex"));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(t.calls.at(-1), { waiting: ["cortex"], ready: [] });
  assert.equal(t.rec.lines.filter((l) => l.msg === "delivered credentials to cortex").length, 2);
});

// @spec STORE-DLV-005
test("a unit the delivery did not reach keeps waiting for the next run", async () => {
  const t = rig({ deliver: () => [] });
  t.r.observe(waiting("cortex"));
  await t.r.start();
  await t.r.run();
  assert.deepEqual(t.calls.map((c) => c.waiting), [["cortex"], ["cortex"]]);
  assert.equal(t.rec.lines.some((l) => l.msg === "delivered credentials to cortex"), false);
});

// @spec STORE-DLV-005
test("a run asked for while one is running waits for it and runs once more after it, however often it was asked", async () => {
  const t = rig();
  t.holdNext();
  const first = t.r.start();
  await new Promise((r) => setImmediate(r));
  assert.equal(t.calls.length, 1);
  const a = t.r.run();
  const b = t.r.run();
  t.r.observe(waiting("voice"));
  await new Promise((r) => setImmediate(r));
  assert.equal(t.calls.length, 1, "nothing runs beside the running one");
  t.openAll();
  await Promise.all([first, a, b]);
  assert.equal(t.calls.length, 2, "one more run after the one in progress");
  assert.deepEqual(t.calls[1], { waiting: ["voice"], ready: [] });
  assert.equal(t.released(), 2);
});

// @spec STORE-DLV-005
test("a run that finds a lifecycle action holding the slot is skipped: nothing delivered, nothing released", async () => {
  let held = true;
  const t = rig({ held: () => held });
  t.r.observe(waiting("cortex"));
  await t.r.start();
  assert.deepEqual(t.calls, []);
  assert.equal(t.released(), 0);
  held = false;
  await t.r.run();
  assert.deepEqual(t.calls, [{ waiting: ["cortex"], ready: [] }], "the unit still waits once the slot is free");
});

// @spec STORE-DLV-005
test("a delivery's failures are logged as warnings and a throwing delivery is logged, the slot released either way", async () => {
  const rec = recordingLog();
  let released = 0;
  let mode: "fail" | "throw" = "fail";
  const r = new Redeliverer({
    redeliver: async () => { if (mode === "throw") throw new Error("docker went away"); return { delivered: [], failures: ["cortex: docker cp failed"] }; },
    acquire: () => () => { released++; }, log: rec.log,
  });
  await r.start();
  assert.ok(rec.lines.some((l) => l.level === "warn" && l.msg === "cortex: docker cp failed"));
  mode = "throw";
  await r.run();
  assert.ok(rec.lines.some((l) => l.level === "warn" && l.msg === "the credentials could not be delivered"));
  assert.equal(released, 2);
});
