import { test } from "node:test";
import assert from "node:assert/strict";
import { ModuleSchema } from "@cohost/config";
import { Module } from "@cohost/modules";
import { FakeBus, event, silentLog, testConfig } from "@cohost/testing";
import { Salience } from "../src/salience.js";
import { scoreRules, type ScoreInput, type ScoreOutput } from "../src/scoring.js";

function setup() {
  const cfg = testConfig({ brain: { salience: { cooldown_ms: 0, idle_chatter_ms: 0 } } });
  const bus = new FakeBus();
  const scorer = new Module<ScoreInput, ScoreOutput>("s", ModuleSchema.parse({}), cfg.llm, { rules: (i) => scoreRules(i, true) }, silentLog);
  return { s: new Salience({ cfg, bus, scorer, log: silentLog }), bus };
}

// @spec SAL-FOCUS-006, BUS-EVT-025
test("a speech focus carries the heard event's audioEndedAt unchanged and heardAt = its envelope ts", async () => {
  const { s, bus } = setup();
  const heard = event("speech.heard", { speaker: "Chris", text: "look at this", durationMs: 900, timing: { audioEndedAt: 123456 } });
  await s.onEvent(heard);
  await s.tick();
  const [focus] = bus.of("attention.focus");
  assert.deepEqual(focus!.timing, { audioEndedAt: 123456, heardAt: heard.ts });
});

// @spec SAL-FOCUS-006
test("a speech focus with no timing, and a chat or vision focus, publish no timing", async () => {
  const bare = setup();
  await bare.s.onEvent(event("speech.heard", { speaker: "Chris", text: "look at this", durationMs: 900 }));
  await bare.s.tick();
  assert.equal(bare.bus.of("attention.focus")[0]!.timing, undefined);

  const chat = setup();
  await chat.s.onEvent(event("chat.message", { platform: "twitch", user: "bob", text: "hey Coco?", isMod: false, isSub: false, mentionsCohost: true }));
  await chat.s.tick();
  assert.equal(chat.bus.of("attention.focus")[0]!.timing, undefined);
});
