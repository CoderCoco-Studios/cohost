import { test } from "node:test";
import assert from "node:assert/strict";
import { event, recordingLog, testConfig } from "@cohost/testing";
import { EARS_LOOP_TYPES, createEarsHandler, subscribeEars } from "../src/session.js";

const utterance = () => event("voice.utterance", { id: "u1", text: "hi", emotion: "neutral", durationMs: 100, envelopeHz: 50, envelope: [0], audioUrl: "http://voice/u1.wav", sampleRate: 24000 });
const inject = () => event("inject.request", { id: "i1", target: "ears", kind: "audio", uploadId: "0123456789abcdef0123456789abcdef", remember: false });

// @spec EARS-INJ-009
test("inject.request is handled by the one ears handler", async () => {
  const handled: string[] = [];
  const h = createEarsHandler({ onInject: async (ev) => { handled.push(ev.data.id); } });
  await h(inject());
  assert.deepEqual(handled, ["i1"]);
});

// @spec EARS-START-003
test("the ears loop reads inject.request only, and the handler ignores anything else it is handed", async () => {
  assert.deepEqual([...EARS_LOOP_TYPES], ["inject.request"]);
  const handled: string[] = [];
  const h = createEarsHandler({ onInject: async (ev) => { handled.push(ev.data.id); } });
  await h(utterance());
  await h(event("voice.playing", { id: "u1", sink: "discord" }));
  assert.deepEqual(handled, []);
});

// @spec EARS-HEAR-009
test("the ears loop never reads control", () => {
  assert.ok(!(EARS_LOOP_TYPES as readonly string[]).includes("control"));
});

// @spec EARS-START-006
test("the ears group is created first, then subscribed with start mode latest for the given types", async () => {
  const calls: string[] = [];
  let opts: unknown;
  const bus = {
    resetGroup: async (g: string) => { calls.push(`reset:${g}`); },
    subscribe: async (o: unknown) => { calls.push("subscribe"); opts = o; },
  };
  await subscribeEars(bus, ["inject.request"], async () => {}, recordingLog().log);
  assert.deepEqual(calls, ["reset:ears", "subscribe"]);
  assert.deepEqual(opts, { group: "ears", types: ["inject.request"], start: "latest" });
});
