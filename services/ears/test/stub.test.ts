import { test } from "node:test";
import assert from "node:assert/strict";
import { runHeartbeat } from "@cohost/testing";
import { wavWrap } from "@cohost/shared";
import { stubTranscriber } from "../src/hearing.js";
import { EarsHealth, earsPlan } from "../src/health.js";

// @spec EARS-STUB-001
test("stub transcriber: fixed text with the clip duration, no network", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error("network used"); }) as never;
  try {
    const t = stubTranscriber();
    assert.equal(await t(wavWrap(Buffer.alloc(32000), 16000, 1)), "stub transcript (1000 ms)");
    assert.equal(await t(Buffer.from("not a wav"), { contentType: "audio/mpeg" }), "stub transcript (0 ms)");
  } finally {
    globalThis.fetch = realFetch;
  }
});

// @spec EARS-STUB-002
test("stub heartbeat: mode mock and stt n/a; off stays off", async () => {
  const live = await runHeartbeat(new EarsHealth(earsPlan(["discord"], true), true, () => "ok").spec);
  assert.equal(live[1]!.mode, "mock");
  assert.equal(live[1]!.deps.stt, "n/a");
  const idle = await runHeartbeat(new EarsHealth(earsPlan(["dir"], false), true, () => "down").spec);
  assert.equal(idle[1]!.mode, "mock");
  const off = await runHeartbeat(new EarsHealth(earsPlan([], true), true).spec);
  assert.equal(off[1]!.mode, "off");
  assert.deepEqual(off[1]!.deps, { discord: "n/a", stt: "n/a" });
});
