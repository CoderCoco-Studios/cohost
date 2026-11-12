import { test } from "node:test";
import assert from "node:assert/strict";
import { EventPayloads } from "../src/index.js";

const control = EventPayloads.control;

// @spec BUS-EVT-004
test("control accepts set_routing with a routing map of enabled and gain_db (-40 to 12) per output, and rejects a malformed one", () => {
  assert.ok(control.safeParse({ cmd: "set_routing", target: "mouth", routing: { discord: { enabled: false, gain_db: -6 }, dryrun: { enabled: true } } }).success);
  assert.ok(control.safeParse({ cmd: "set_routing", routing: {} }).success);
  assert.ok(control.safeParse({ cmd: "mute" }).success, "routing stays optional");
  for (const routing of [{ discord: { enabled: "yes" } }, { discord: { gain_db: 13 } }, { discord: { gain_db: -41 } }, { discord: { gain_db: "x" } }, { discord: { volume: 1 } }, [], "x"]) {
    assert.equal(control.safeParse({ cmd: "set_routing", routing }).success, false, JSON.stringify(routing));
  }
});
