import { test } from "node:test";
import assert from "node:assert/strict";
import { Bus } from "../src/index.js";

// @spec BUS-STREAM-009
test("failFast: the publish connection has no reconnect strategy and a silent error listener", () => {
  let opts: Record<string, unknown> = {};
  let listener: string | undefined;
  const fake = { on: (ev: string) => { listener = ev; return fake; }, disconnect: () => {} };
  new Bus("t", undefined, "redis://fake", { failFast: true, connect: (_u: string, o: Record<string, unknown>) => { opts = o; return fake as never; } });
  assert.equal(typeof opts.retryStrategy, "function");
  assert.equal((opts.retryStrategy as () => unknown)(), null);
  assert.equal(listener, "error");
});

// @spec BUS-STREAM-009
test("failFast off (default): reconnects as before", () => {
  let opts: Record<string, unknown> = {};
  new Bus("t", undefined, "redis://fake", { connect: (_u: string, o: Record<string, unknown>) => { opts = o; return { disconnect: () => {} } as never; } });
  assert.equal(opts.retryStrategy, undefined);
});

// @spec BUS-STREAM-009
test("failFast against a closed port: the first command rejects quickly and nothing is printed", async () => {
  const errs: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { errs.push(a.join(" ")); };
  const bus = new Bus("t", undefined, "redis://127.0.0.1:1", { failFast: true });
  try {
    const t0 = Date.now();
    await assert.rejects(bus.recentHealth(1));
    assert.ok(Date.now() - t0 < 3000);
  } finally {
    console.error = orig;
    bus.stop();
  }
  assert.deepEqual(errs, []);
});
