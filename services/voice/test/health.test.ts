import { test } from "node:test";
import assert from "node:assert/strict";
import { runHeartbeat } from "@cohost/testing";
import { VoiceHealth } from "../src/health.js";

test("kokoro ok by default; shutdown sends one stopping", async () => {
  const hbs = await runHeartbeat(new VoiceHealth().spec);
  assert.deepEqual(hbs.map((h) => h.state), ["starting", "ready", "stopping"]);
  assert.deepEqual(hbs[1]!.deps, { kokoro: "ok" });
  assert.equal(hbs[1]!.service, "voice");
});

test("a failed synthesis marks kokoro down (degraded), the next success marks it ok", async () => {
  const h = new VoiceHealth();
  let fail = true;
  const synth = h.track(async () => { if (fail) throw new Error("tts 500"); return Buffer.from("x"); });
  await assert.rejects(synth("hi"));
  let hbs = await runHeartbeat(h.spec);
  assert.deepEqual(hbs[1]!.deps, { kokoro: "down" });
  assert.equal(hbs[1]!.state, "degraded");
  fail = false;
  await synth("hi");
  hbs = await runHeartbeat(h.spec);
  assert.deepEqual(hbs[1]!.deps, { kokoro: "ok" });
  assert.equal(hbs[1]!.state, "ready");
});
