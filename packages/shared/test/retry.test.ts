import { test } from "node:test";
import assert from "node:assert/strict";
import { retryWithBackoff, singleFlight } from "../src/index.js";

const sleeper = () => {
  const sleeps: number[] = [];
  return { sleeps, sleep: async (ms: number) => { sleeps.push(ms); } };
};

// @spec SHARED-RETRY-001
test("waits firstDelayMs, then calls attempt until it resolves and returns its value", async () => {
  const { sleeps, sleep } = sleeper();
  let calls = 0;
  const v = await retryWithBackoff(async () => { if (++calls < 3) throw new Error("x"); return "ok"; },
    { baseMs: 10, maxMs: 100, firstDelayMs: 7, sleep });
  assert.equal(v, "ok");
  assert.equal(calls, 3);
  assert.equal(sleeps[0], 7);
  const none = sleeper();
  await retryWithBackoff(async () => 1, { baseMs: 10, maxMs: 100, sleep: none.sleep });
  assert.deepEqual(none.sleeps, [], "firstDelayMs defaults to 0: no wait");
});

// @spec SHARED-RETRY-002
test("after the n-th failure it reports onFailure(err, n, delayMs) then waits min(maxMs, baseMs * factor^(n-1))", async () => {
  const { sleeps, sleep } = sleeper();
  const failures: [string, number, number][] = [];
  let calls = 0;
  await retryWithBackoff(async () => { if (++calls <= 6) throw new Error(`e${calls}`); },
    { baseMs: 5000, maxMs: 60_000, sleep, onFailure: (err, n, d) => failures.push([String(err), n, d]) });
  assert.deepEqual(sleeps, [5000, 10_000, 20_000, 40_000, 60_000, 60_000]);
  assert.deepEqual(failures.map((f) => [f[1], f[2]]), [[1, 5000], [2, 10_000], [3, 20_000], [4, 40_000], [5, 60_000], [6, 60_000]]);
  assert.equal(failures[0]![0], "Error: e1");
  const fixed = sleeper();
  let n = 0;
  await retryWithBackoff(async () => { if (++n <= 3) throw new Error("x"); }, { baseMs: 3000, maxMs: 3000, factor: 1, sleep: fixed.sleep });
  assert.deepEqual(fixed.sleeps, [3000, 3000, 3000]);
});

// @spec SHARED-RETRY-003
test("isStopped is checked before every attempt and after every wait and resolves undefined", async () => {
  const { sleep } = sleeper();
  let calls = 0;
  let stopped = false;
  const v = await retryWithBackoff(async () => { calls++; throw new Error("x"); },
    { baseMs: 1, maxMs: 1, sleep, isStopped: () => stopped, onFailure: () => { if (calls === 3) stopped = true; } });
  assert.equal(v, undefined);
  assert.equal(calls, 3);
  let called = 0;
  assert.equal(await retryWithBackoff(async () => { called++; return 1; }, { baseMs: 1, maxMs: 1, sleep, isStopped: () => true }), undefined);
  assert.equal(called, 0, "already stopped: no attempt");
  let afterWait = 0;
  const s2 = async () => { stopped = true; };
  stopped = false;
  assert.equal(await retryWithBackoff(async () => { afterWait++; return 1; }, { baseMs: 1, maxMs: 1, firstDelayMs: 5, sleep: s2, isStopped: () => stopped }), undefined);
  assert.equal(afterWait, 0, "stopped during the first wait: no attempt");
});

// @spec SHARED-RETRY-004
test("a fatal error rejects at once, without onFailure or a wait", async () => {
  const { sleeps, sleep } = sleeper();
  let reported = 0;
  await assert.rejects(
    retryWithBackoff(async () => { throw new Error("bad config"); },
      { baseMs: 1, maxMs: 1, sleep, isFatal: (e) => /bad config/.test(String(e)), onFailure: () => { reported++; } }),
    /bad config/,
  );
  assert.equal(reported, 0);
  assert.deepEqual(sleeps, []);
});

// @spec SHARED-RETRY-005
test("a throwing onFailure is ignored and retrying continues", async () => {
  const { sleep } = sleeper();
  let calls = 0;
  const v = await retryWithBackoff(async () => { if (++calls < 3) throw new Error("x"); return calls; },
    { baseMs: 1, maxMs: 1, sleep, onFailure: () => { throw new Error("reporter broke"); } });
  assert.equal(v, 3);
});

// @spec SHARED-RETRY-006
test("singleFlight shares one running call and starts a new one after it settles", async () => {
  let started = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const run = singleFlight(async (n: number) => { started++; await gate; return n; });
  const [a, b] = [run(1), run(2)];
  release();
  assert.deepEqual(await Promise.all([a, b]), [1, 1]);
  assert.equal(started, 1);
  assert.equal(await run(3), 3);
  assert.equal(started, 2);
});

// @spec SHARED-RETRY-007
test("sleep defaults to a real timer (a short delay really waits)", async () => {
  let calls = 0;
  const t0 = performance.now();
  await retryWithBackoff(async () => { if (++calls < 2) throw new Error("x"); }, { baseMs: 30, maxMs: 30 });
  assert.ok(performance.now() - t0 >= 25);
});
