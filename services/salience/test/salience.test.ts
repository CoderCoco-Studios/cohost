import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfigSchema, ModuleSchema } from "@cohost/config";
import { Module } from "@cohost/modules";
import { Context } from "@cohost/working-memory";
import { scoreRules, toScoreInput, type ScoreInput, type ScoreOutput } from "../src/scoring.js";
import { Reflexes } from "../src/reflex.js";
import { Scheduler } from "../src/scheduler.js";

const log = { warn() {}, info() {}, error() {}, debug() {} } as never;
const salienceCfg = (over: Record<string, unknown> = {}) =>
  ConfigSchema.shape.brain.shape.salience.parse({ cooldown_ms: 0, idle_chatter_ms: 0, ...over });
const rulesScorer = (replyOnMention = true) =>
  new Module<ScoreInput, ScoreOutput>("s", ModuleSchema.parse({}), {} as never, { rules: (i) => scoreRules(i, replyOnMention) }, log);

const chat = (text: string, extra: Record<string, unknown> = {}) =>
  ({ id: "1", type: "chat.message", ts: Date.now(), source: "t", data: { platform: "twitch", user: "u", text, isMod: false, isSub: false, mentionsCohost: false, ...extra } }) as never;
const vision = (text: string, changed = true) =>
  ({ id: "1", type: "vision.summary", ts: Date.now(), source: "t", data: { text, changed } }) as never;

test("scoreRules: the documented weights", () => {
  const input: ScoreInput = {
    arousal: 0,
    events: [
      { kind: "chat", text: "hi", mention: true, isMod: false, isSub: false, changed: false },
      { kind: "chat", text: "why?", mention: false, isMod: false, isSub: false, changed: false },
      { kind: "chat", text: "mod here", mention: false, isMod: true, isSub: false, changed: false },
      { kind: "chat", text: "plain", mention: false, isMod: false, isSub: false, changed: false },
      { kind: "speech", text: "said", mention: false, isMod: false, isSub: false, changed: false },
      { kind: "vision", text: "screen", mention: false, isMod: false, isSub: false, changed: true },
      { kind: "vision", text: "screen", mention: false, isMod: false, isSub: false, changed: false },
    ],
  };
  assert.deepEqual(scoreRules(input, true).scores, [1.0, 0.55, 0.35, 0.15, 0.9, 0.3, 0]);
  assert.equal(scoreRules(input, false).scores[0], 0.15); // reply_on_mention off: a mention is plain chat
});

test("toScoreInput flattens the working memory in order and skips self lines", () => {
  const ctx = new Context(10);
  ctx.push(chat("a"));
  ctx.pushSelf("me", "neutral");
  ctx.push(vision("v"));
  const input = toScoreInput(ctx.unseen().filter((e) => e.kind !== "self"), 0.5);
  assert.equal(input.arousal, 0.5);
  assert.deepEqual(input.events.map((e) => e.kind), ["chat", "vision"]);
});

test("Reflexes: match, sense filter, per-rule cooldown, random pick", () => {
  const r = new Reflexes([
    { match: "\\b(you died|game over)\\b", on: ["vision"], say: ["Oof."], emotion: "surprised", cooldown_ms: 1000 },
    { match: "raid", on: ["chat"], say: ["A", "B"], emotion: "happy", cooldown_ms: 0 },
  ]);
  assert.equal(r.size, 2);
  assert.equal(r.test("chat", "YOU DIED"), undefined); // wrong sense
  const hit = r.test("vision", "Big red YOU DIED text", 1000);
  assert.equal(hit?.text, "Oof.");
  assert.equal(hit?.emotion, "surprised");
  assert.equal(r.test("vision", "you died again", 1500), undefined); // in cooldown
  assert.ok(r.test("vision", "you died again", 2001));
  assert.ok(["A", "B"].includes(r.test("chat", "incoming raid!")!.text));
});

test("Scheduler: muted, busy, cooldown, threshold, focus, mark-seen cycle", async () => {
  const sch = new Scheduler(salienceCfg({ cooldown_ms: 5000 }), rulesScorer());
  const ctx = new Context(10);
  assert.equal((await sch.decide(ctx, false, true)).reason, "muted");
  assert.equal((await sch.decide(ctx, true, false)).reason, "cortex busy");
  assert.equal((await sch.decide(ctx, false, false)).reason, "nothing new");
  ctx.push(chat("just chatting"));
  let d = await sch.decide(ctx, false, false);
  assert.equal(d.speak, false); // 0.15 < 0.6
  ctx.push(chat("hey Coco?", { mentionsCohost: true }));
  d = await sch.decide(ctx, false, false);
  assert.equal(d.speak, true);
  assert.equal(d.reason, "mentioned");
  assert.equal(d.focus?.kind, "chat");
  assert.ok(Math.abs(d.score - 1.15) < 1e-9);
  ctx.markSeen();
  sch.noteSpoke();
  assert.equal((await sch.decide(ctx, false, false)).reason, "cooldown");
});

test("Scheduler: arousal lowers the threshold; idle chatter fires after quiet", async () => {
  const sch = new Scheduler(salienceCfg({ speak_threshold: 0.6, arousal_bias: 0.5 }), rulesScorer());
  const ctx = new Context(10);
  ctx.push(chat("plain"));
  ctx.push(chat("plain"));
  ctx.push(chat("plain")); // 0.45 total
  assert.equal((await sch.decide(ctx, false, false, 0)).speak, false);
  assert.equal((await sch.decide(ctx, false, false, 1)).speak, true); // threshold 0.6 - 0.5 = 0.1

  const idle = new Scheduler(salienceCfg({ idle_chatter_ms: 1 }), rulesScorer());
  const ctx2 = new Context(10);
  ctx2.push(chat("plain"));
  await new Promise((r) => setTimeout(r, 5));
  const d = await idle.decide(ctx2, false, false);
  assert.equal(d.speak, true);
  assert.equal(d.reason, "idle chatter");
});

test("Scheduler: an unchanged unseen set is scored once, not every tick", async () => {
  let calls = 0;
  const counting = new Module<ScoreInput, ScoreOutput>("s", ModuleSchema.parse({}), {} as never, {
    rules: (i) => { calls++; return scoreRules(i, true); },
  }, log);
  const sch = new Scheduler(salienceCfg(), counting);
  const ctx = new Context(10);
  ctx.push(chat("plain one"));
  for (let i = 0; i < 5; i++) await sch.decide(ctx, false, false);
  assert.equal(calls, 1);
  ctx.push(chat("plain two")); // only the new event is sent to the scorer
  const d = await sch.decide(ctx, false, false);
  assert.equal(calls, 2);
  assert.equal(d.scored.length, 2);
});

test("Scheduler: events that arrive during scoring are not in `scored` and stay unseen", async () => {
  const ctx = new Context(10);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const slow = new Module<ScoreInput, ScoreOutput>("s", ModuleSchema.parse({}), {} as never, {
    rules: (i) => scoreRules(i, true),
  }, log);
  const run = slow.run.bind(slow);
  slow.run = async (i) => { await gate; return run(i); };
  const sch = new Scheduler(salienceCfg(), slow);
  ctx.push(chat("hey Coco?", { mentionsCohost: true }));
  const pending = sch.decide(ctx, false, false);
  ctx.push(chat("Coco, did you see that?", { mentionsCohost: true })); // lands mid-await
  release();
  const d = await pending;
  assert.equal(d.speak, true);
  assert.equal(d.scored.length, 1);
  ctx.markSeenEvents(d.scored);
  assert.equal(ctx.unseen().length, 1); // the late mention is still waiting for its own decision
  assert.equal((ctx.unseen()[0] as { text: string }).text, "Coco, did you see that?");
});

test("Scheduler.cooling and Context.last/markSeenEvents", async () => {
  const sch = new Scheduler(salienceCfg({ cooldown_ms: 1000 }), rulesScorer());
  assert.equal(sch.cooling(), false);
  sch.noteSpoke();
  assert.equal(sch.cooling(), true);
  const ctx = new Context(10);
  ctx.push(chat("a"));
  ctx.push(chat("b"));
  assert.equal((ctx.last() as { text: string }).text, "b");
  ctx.markSeenEvents([ctx.last()!]);
  assert.deepEqual(ctx.unseen().map((e) => (e as { text: string }).text), ["a"]);
});
