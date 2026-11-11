import { test } from "node:test";
import assert from "node:assert/strict";
import { createJoiner } from "../src/index.js";

const sleeper = () => {
  const sleeps: number[] = [];
  return { sleeps, sleep: async (ms: number) => { sleeps.push(ms); } };
};

// @spec EARS-SESS-006
test("a failed join is reported and retried with increasing delay until it succeeds", async () => {
  const { sleeps, sleep } = sleeper();
  const failures: [string, number][] = [];
  let calls = 0;
  const joiner = createJoiner({
    join: async () => { if (++calls <= 3) throw new Error(`no voice ${calls}`); },
    onFailure: (err, attempt) => failures.push([String(err), attempt]),
    sleep,
  });
  await joiner.run();
  assert.equal(calls, 4);
  assert.deepEqual(failures, [["Error: no voice 1", 1], ["Error: no voice 2", 2], ["Error: no voice 3", 3]]);
  assert.deepEqual(sleeps, [5000, 10_000, 20_000]);
});

// @spec EARS-SESS-006
test("the retry delay is capped, and a rejoin waits its first delay before the first attempt", async () => {
  const { sleeps, sleep } = sleeper();
  let calls = 0;
  await createJoiner({ join: async () => { if (++calls <= 6) throw new Error("x"); }, onFailure() {}, sleep }).run(5000);
  assert.deepEqual(sleeps, [5000, 5000, 10_000, 20_000, 40_000, 60_000, 60_000]);
});

// @spec EARS-SESS-006
test("concurrent runs share one retry loop, and stopping ends it", async () => {
  const { sleep } = sleeper();
  let calls = 0;
  let stopped = false;
  const joiner = createJoiner({
    join: async () => { calls++; throw new Error("x"); },
    onFailure: () => { if (calls === 3) stopped = true; },
    sleep, isStopped: () => stopped,
  });
  await Promise.all([joiner.run(), joiner.run()]);
  assert.equal(calls, 3);
});
