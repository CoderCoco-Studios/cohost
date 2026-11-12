import { test } from "node:test";
import assert from "node:assert/strict";
import { event, FakeBus } from "../src/index.js";

const ID = /^\d+-\d+$/;
const idKey = (id: string): [number, number] => { const [ms, seq] = id.split("-"); return [Number(ms), Number(seq)]; };
const after = (a: string, b: string): boolean => { const [am, as] = idKey(a); const [bm, bs] = idKey(b); return am > bm || (am === bm && as > bs); };
const hb = (service: string) => ({ service, instance: "i", pid: 1, version: "0", startedAt: 1, state: "ready" as const, deps: {}, mode: "live", intervalMs: 5000 });

// @spec BUS-TEST-011
test("FakeBus.publish and publishHealth return Redis-form ids that strictly increase", async () => {
  const bus = new FakeBus();
  const ids = [
    await bus.publish("control", { cmd: "mute" }),
    await bus.publish("control", { cmd: "unmute" }),
    await bus.publish("brain.status", { state: "idle" }),
    await bus.publishHealth(hb("a")),
    await bus.publishHealth(hb("b")),
  ];
  for (const id of ids) assert.match(id, ID);
  for (let i = 1; i < ids.length; i++) assert.ok(after(ids[i]!, ids[i - 1]!), `${ids[i]} after ${ids[i - 1]}`);
});

// @spec BUS-TEST-011, BUS-TEST-006
test("event() ids have the same form and increase with the FakeBus's", async () => {
  const first = event("control", { cmd: "mute" }).id;
  const published = await new FakeBus().publish("control", { cmd: "mute" });
  const second = event("control", { cmd: "mute" }).id;
  for (const id of [first, published, second]) assert.match(id, ID);
  assert.ok(after(published, first) && after(second, published));
});

// @spec BUS-TEST-003
test("recentHealth returns the last count heartbeats carrying the ids publishHealth returned", async () => {
  const bus = new FakeBus();
  const ids: string[] = [];
  for (const s of ["a", "b", "c", "d"]) ids.push(await bus.publishHealth(hb(s)));
  const got = await bus.recentHealth(3);
  assert.deepEqual(got.map((h) => h.data.service), ["b", "c", "d"]);
  assert.deepEqual(got.map((h) => h.id), ids.slice(1));
  assert.ok(got.every((h) => h.type === "service.heartbeat"));
});
