import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { ModuleSchema } from "@cohost/config";
import { Module } from "@cohost/modules";
import { FakeBus, event, silentLog, testConfig } from "@cohost/testing";
import { Affect } from "../src/affect.js";
import { appraiseRules, type AppraiseInput, type AppraiseOutput } from "../src/appraise.js";

const cfg = testConfig({ brain: { affect: { baseline_valence: 0, half_life_ms: 10_000_000 } } });

function setup(kind: "rules" | "http" = "rules") {
  const bus = new FakeBus();
  const mod = new Module<AppraiseInput, AppraiseOutput>(
    "a", ModuleSchema.parse(kind === "http" ? { kind, url: "http://unused" } : {}), cfg.llm,
    { rules: appraiseRules, http: { validate: () => undefined } }, silentLog,
  );
  const seen: AppraiseInput[] = [];
  let release: (() => void) | undefined;
  if (kind === "http") {
    // Stand-in for a slow model: each call waits until the test lets it go, then nudges valence up.
    mod.run = async (i) => {
      seen.push(i);
      await new Promise<void>((r) => (release = r));
      return { valence_delta: 0.1, arousal_delta: 0 };
    };
  }
  const affect = new Affect({ cfg, bus, appraiser: mod, log: silentLog });
  return { affect, bus, seen, next: () => release?.() };
}
const chat = (text: string, extra: Record<string, unknown> = {}) =>
  event("chat.message", { platform: "twitch", user: "bob", text, isMod: false, isSub: false, mentionsCohost: false, ...extra });
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

test("chat and speech are appraised with the word lists (rules kind)", () => {
  const { affect } = setup();
  affect.onEvent(chat("lol that was clutch"));
  assert.ok(affect.mood.valence > 0);
  assert.equal(affect.mood.cause, "chat: bob");
  const v = affect.mood.valence;
  affect.onEvent(event("speech.heard", { speaker: "Chris", text: "this is trash", durationMs: 900 }));
  assert.ok(affect.mood.valence < v);
  assert.equal(affect.mood.cause, "voice: Chris");
});

test("subs, screen changes and the co-host's own lines nudge the mood", () => {
  const { affect } = setup();
  const a0 = affect.mood.arousal;
  affect.onEvent(event("vision.summary", { text: "x", changed: false }));
  assert.equal(affect.mood.arousal, a0);
  affect.onEvent(event("vision.summary", { text: "x", changed: true }));
  assert.ok(near(affect.mood.arousal, a0 + 0.08));
  assert.equal(affect.mood.cause, "screen changed");

  const v0 = affect.mood.valence;
  affect.onEvent(event("brain.say", { id: "1", text: "yay", emotion: "laugh" }));
  assert.ok(near(affect.mood.valence, v0 + 0.08));
  affect.onEvent(event("brain.say", { id: "2", text: "ugh", emotion: "angry" }));
  assert.ok(near(affect.mood.valence, v0));
  affect.onEvent(event("brain.say", { id: "3", text: "hm", emotion: "think" }));
  assert.ok(near(affect.mood.valence, v0));
  assert.equal(affect.mood.cause, "said: think");

  const s = setup();
  s.affect.onEvent(chat("ok", { isSub: true }));
  assert.equal(s.affect.mood.cause, "sub: bob");
});

test("forget_context snaps the mood back to baseline", () => {
  const { affect } = setup();
  for (let i = 0; i < 5; i++) affect.onEvent(chat("LOL POGGERS!!!"));
  affect.onEvent(event("control", { cmd: "forget_context" }));
  assert.ok(near(affect.mood.valence, 0));
  assert.ok(near(affect.mood.arousal, 0.1));
  assert.equal(affect.mood.cause, "reset");
});

test("publish: only when the state moved, plus a 15 s heartbeat", () => {
  mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  try {
    const { affect, bus } = setup();
    affect.publish();
    affect.publish();
    assert.equal(bus.of("affect.state").length, 1);
    affect.onEvent(chat("lol nice"));
    affect.publish();
    assert.equal(bus.of("affect.state").length, 2);
    assert.ok(bus.of("affect.state")[1]!.valence > 0);
    mock.timers.tick(14_000);
    affect.publish();
    assert.equal(bus.of("affect.state").length, 2);
    mock.timers.tick(1_000);
    affect.publish();
    assert.equal(bus.of("affect.state").length, 3);
  } finally { mock.timers.reset(); }
});

test("llm/http kind: lines queue for the slow appraiser instead of blocking the handler", async () => {
  const { affect, seen, next } = setup("http");
  affect.onEvent(chat("what a great play"));
  affect.onEvent(chat("love this game"));
  assert.equal(seen.length, 1, "one at a time");
  assert.equal(affect.mood.valence, 0, "nothing applied yet");
  next();
  await new Promise((r) => setImmediate(r));
  assert.ok(near(affect.mood.valence, 0.1));
  assert.equal(seen.length, 2);
  assert.ok(near(seen[1]!.valence, 0.1), "the queued line is appraised against the mood as it is now");
  next();
  await affect.settled();
  assert.ok(near(affect.mood.valence, 0.2));
});

test("llm/http kind: a too-short line skips the model; a mention never does", async () => {
  const { affect, seen, next } = setup("http");
  affect.onEvent(chat("gg"));
  assert.equal(seen.length, 0);
  assert.ok(affect.mood.valence > 0, "rules applied inline");
  affect.onEvent(chat("hi", { mentionsCohost: true }));
  assert.equal(seen.length, 1);
  next();
  await affect.settled();
});

test("llm/http kind: when appraisal falls behind, the oldest waiting lines are dropped", async () => {
  const { affect, seen, next } = setup("http");
  for (let i = 0; i < 12; i++) affect.onEvent(chat(`line number ${i}`));
  // #0 is in flight; of #1..#11 only the newest 8 are kept.
  for (let i = 0; i < 12 && seen.length <= 9; i++) { next(); await new Promise((r) => setImmediate(r)); }
  await affect.settled();
  assert.deepEqual(seen.map((s) => s.text), ["line number 0", ...[4, 5, 6, 7, 8, 9, 10, 11].map((n) => `line number ${n}`)]);
});
