import { test } from "node:test";
import assert from "node:assert/strict";
import type { HeartbeatEvent } from "@cohost/bus";
import { executeCli, heartbeatSets, parseCli, type CliWiring, type LockResult } from "../src/index.js";

const beat = (service: string, state: string, ts: number, detail?: string): HeartbeatEvent =>
  ({ ts, data: { service, state, ...(detail ? { detail } : {}) } }) as unknown as HeartbeatEvent;

// @spec CTRL-CLI-019
test("heartbeatSets: a unit's newest heartbeat decides whether it waits for credentials or holds them", () => {
  const s = heartbeatSets([
    beat("cortex", "starting", 1, "waiting for credentials"),
    beat("voice", "starting", 1, "waiting for credentials"), beat("voice", "ready", 2),
    beat("chat", "degraded", 3), beat("ears", "starting", 3),
  ]);
  assert.deepEqual([...s.waiting], ["cortex"]);
  assert.deepEqual([...s.ready].toSorted(), ["chat", "voice"]);
});

function wiring(o: { recentHealth?: () => Promise<HeartbeatEvent[]>; failures?: string[] } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const actions: string[] = [];
  const asked: { waiting: string[]; ready: string[] }[] = [];
  const w: CliWiring = {
    configRefusal: async () => undefined,
    openBus: () => ({ publish: async () => "1", resetGroup: async () => {}, recentHealth: o.recentHealth ?? (async () => [beat("cortex", "starting", 1, "waiting for credentials")]), recent: async () => [], stop: () => {} }) as never,
    buildRuntime: () => ({ name: "compose" }) as never,
    redeliver: async (sets) => { asked.push({ waiting: [...sets.waiting], ready: [...sets.ready] }); return { delivered: ["cortex"], failures: o.failures ?? [] }; },
    lock: { tryAcquire: (action: string): LockResult => { actions.push(action); return { ok: true, release: () => {} }; } },
    out: (l) => out.push(l), err: (l) => err.push(l), env: { REDIS_URL: "redis://127.0.0.1:1" },
  };
  return { w, out, err, actions, asked };
}

// @spec CTRL-CLI-019
test("cohostctl deliver takes the lifecycle lock as deliver, prints one line per unit delivered, and exits 1 naming each failure", async () => {
  assert.deepEqual(parseCli(["deliver"]), { cmd: "deliver" });
  const h = wiring();
  assert.equal(await executeCli(["deliver"], h.w), 0);
  assert.deepEqual(h.actions, ["deliver"]);
  assert.deepEqual(h.asked, [{ waiting: ["cortex"], ready: [] }]);
  assert.deepEqual(h.out, ["delivered credentials to cortex"]);
  const bad = wiring({ failures: ["the credentials of voice could not be delivered (docker exec exited 1)"] });
  assert.equal(await executeCli(["deliver"], bad.w), 1);
  assert.deepEqual(bad.err, ["the credentials of voice could not be delivered (docker exec exited 1)"]);
});

// @spec CTRL-CLI-019, CTRL-CLI-017
test("cohostctl deliver without Redis warns, naming Redis, and delivers by StartedAt alone", async () => {
  const h = wiring({ recentHealth: async () => { throw Object.assign(new Error("connection refused"), { code: "BUS_CONNECTION" }); } });
  assert.equal(await executeCli(["deliver"], h.w), 0);
  assert.match(h.err[0]!, /^warning: cannot reach Redis at redis:\/\/127\.0\.0\.1:1: connection refused; delivering to the units started since their last delivery only$/);
  assert.deepEqual(h.asked, [{ waiting: [], ready: [] }]);
});
