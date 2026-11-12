import { test } from "node:test";
import assert from "node:assert/strict";
import type { BusEvent, EventType } from "@cohost/bus";
import { controlFor } from "../src/index.js";

const event = (type: EventType, data: unknown): BusEvent => ({ id: "1", type, ts: Date.now(), source: "t", data } as never);

// @spec SHARED-CTRL-005
test("set_routing is handed to the service's handler with the event's data and changes no reader state", async () => {
  const seen: unknown[] = [];
  const c = controlFor("mouth", { set_routing: (d) => { seen.push(d.routing); } });
  await c.handleAsync(event("control", { cmd: "set_routing", target: "mouth", routing: { discord: { enabled: false } } }));
  assert.deepEqual(seen, [{ discord: { enabled: false } }]);
  assert.equal(c.paused, false);
  assert.equal(c.muted, false);
  assert.equal(c.epoch, 0);
  await c.handleAsync(event("control", { cmd: "set_routing", target: "cortex", routing: { discord: { enabled: true } } }));
  assert.equal(seen.length, 1, "addressed to another service");
  const none = controlFor("mouth", {});
  assert.equal(await none.handleAsync(event("control", { cmd: "set_routing", routing: {} })), true, "no handler: nothing happens");
});
