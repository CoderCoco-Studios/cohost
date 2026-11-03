import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeBus, recordingLog } from "@cohost/testing";
import { statePublisher } from "../src/state.js";
import { NEUTRAL, type AvatarParams } from "../src/types.js";

const params: AvatarParams = { mouthOpen: 0.5, mouthSmile: 0.7, headX: 1, headY: 2, headZ: 3, eyeX: 0.1, eyeY: 0.2, blink: 1 };
const flush = () => new Promise((r) => setImmediate(r));

function setup(connected = true) {
  const bus = new FakeBus();
  const rec = recordingLog();
  let t = 1_000;
  const publish = statePublisher({ bus, driver: { name: "vmc", connected: () => connected }, log: rec.log, now: () => t });
  return { bus, rec, publish, at: (ms: number) => { t = ms; } };
}

// @spec AVATAR-STATE-001
test("avatar.state carries every canonical parameter including mouthSmile, plus emotion, intensity, driver and connected", async () => {
  const { bus, publish } = setup(false);
  publish(params, "happy", 1);
  await flush();
  assert.deepEqual(bus.of("avatar.state"), [{ ...params, emotion: "happy", intensity: 1, driver: "vmc", connected: false }]);
  assert.equal(bus.of("avatar.state")[0]!.mouthSmile, 0.7); // survives the schema, so the dashboard preview reads a number
});

// @spec AVATAR-STATE-001
test("avatar.state is published at most once every 200 ms", async () => {
  const { bus, publish, at } = setup();
  publish(NEUTRAL, "neutral", 0); // t=1000
  at(1100); publish(NEUTRAL, "neutral", 0);
  at(1199); publish(NEUTRAL, "neutral", 0);
  at(1200); publish(NEUTRAL, "happy", 1);
  await flush();
  assert.deepEqual(bus.of("avatar.state").map((s) => s.emotion), ["neutral", "happy"]);
});

// @spec AVATAR-STATE-002
test("a failed avatar.state publish is dropped, logged once per interval, and never an unhandled rejection", async () => {
  const { bus, rec, publish, at } = setup();
  bus.fail = (type) => type === "avatar.state";
  const unhandled: unknown[] = [];
  const onRejection = (e: unknown) => { unhandled.push(e); };
  process.on("unhandledRejection", onRejection);
  try {
    for (let i = 0; i < 20; i++) { at(1_000 + i * 200); publish(params, "happy", 1); await flush(); } // 20 failing publishes over 3.8 s
    assert.deepEqual(unhandled, []);
    assert.deepEqual(rec.msgs("warn"), ["avatar.state publish failed"]); // one line for the whole burst
    at(1_000 + 20 * 200 + 10_000); publish(params, "happy", 1); await flush(); // a later failure logs again
    assert.equal(rec.msgs("warn").length, 2);
    bus.fail = undefined;
    at(1_000 + 20 * 200 + 10_400); publish(params, "sad", 1); await flush();
    assert.deepEqual(bus.of("avatar.state").map((s) => s.emotion), ["sad"]); // publishing resumed
  } finally { process.off("unhandledRejection", onRejection); }
});
