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

let seq = 0;
const chat = (text: string, extra: Record<string, unknown> = {}) =>
  ({ id: `c${seq++}`, type: "chat.message", ts: Date.now(), source: "t", data: { platform: "twitch", user: "u", text, isMod: false, isSub: false, mentionsCohost: false, ...extra } }) as never;
const vision = (text: string, changed = true) =>
  ({ id: `v${seq++}`, type: "vision.summary", ts: Date.now(), source: "t", data: { text, changed } }) as never;

test("scoreRules: the documented weights", () => { // @spec SAL-SCORE-001, SAL-SCORE-002
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

test("toScoreInput flattens the working memory in order and skips self lines", () => { // @spec SAL-SCORE-003
  const ctx = new Context(10);
  ctx.push(chat("a"));
  ctx.pushSelf("me", "neutral", 1000);
  ctx.push(vision("v"));
  const input = toScoreInput(ctx.unseen().filter((e) => e.kind !== "self"), 0.5);
  assert.equal(input.arousal, 0.5);
  assert.deepEqual(input.events.map((e) => e.kind), ["chat", "vision"]);
});

test("Reflexes: match, sense filter, per-rule cooldown, random pick", () => { // @spec SAL-REFLEX-001, SAL-REFLEX-003
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

test("Scheduler: muted, busy, cooldown, threshold, focus, mark-seen cycle", async () => { // @spec SAL-DECIDE-001, SAL-DECIDE-002, SAL-DECIDE-003, SAL-DECIDE-006
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

test("Scheduler: arousal lowers the threshold; idle chatter fires after quiet", async () => { // @spec SAL-DECIDE-003, SAL-DECIDE-004
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

test("Scheduler: an unchanged unseen set is scored once, not every tick", async () => { // @spec SAL-SCORE-006
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

test("Scheduler: events that arrive during scoring are not in `scored` and stay unseen", async () => { // @spec SAL-DECIDE-007
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

// ---- counting a burst (issue #172)

const from = (userId: string, text: string, extra: Record<string, unknown> = {}) => chat(text, { userId, user: `name-${userId}`, ...extra });
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} !~ ${b}`);
const speech = (text: string) =>
  ({ id: `s${seq++}`, type: "speech.heard", ts: Date.now(), source: "t", data: { speaker: "chris", text, final: true } }) as never;

test("Scheduler: one viewer's ten-line burst adds one score", async () => { // @spec SAL-DECIDE-002, SAL-DECIDE-011, SAL-DECIDE-013
  const sch = new Scheduler(salienceCfg(), rulesScorer());
  const ctx = new Context(20);
  for (let i = 0; i < 10; i++) ctx.push(from("v1", `line ${i}`));
  const d = await sch.decide(ctx, false, false);
  near(d.score, 0.15);
  assert.equal(d.speak, false);
});

test("Scheduler: one text pasted by ten viewers adds one score", async () => { // @spec SAL-DECIDE-002, SAL-DECIDE-011, SAL-DECIDE-012
  const sch = new Scheduler(salienceCfg(), rulesScorer());
  const ctx = new Context(20);
  for (let i = 0; i < 10; i++) ctx.push(from(`v${i}`, i % 2 ? "SPAM  spam" : "spam spam"));
  near((await sch.decide(ctx, false, false)).score, 0.15);
});

test("Scheduler: ten viewers with ten texts all count", async () => { // @spec SAL-DECIDE-002, SAL-DECIDE-011
  const sch = new Scheduler(salienceCfg(), rulesScorer());
  const ctx = new Context(20);
  for (let i = 0; i < 10; i++) ctx.push(from(`v${i}`, `distinct ${i}`));
  const d = await sch.decide(ctx, false, false);
  near(d.score, 1.5);
  assert.equal(d.speak, true);
});

test("Scheduler: viewers compare by platform and id, not display name", async () => { // @spec SAL-DECIDE-012
  const sch = new Scheduler(salienceCfg(), rulesScorer());
  const ctx = new Context(20);
  ctx.push(chat("one", { platform: "twitch", userId: "1", user: "Sam" }));
  ctx.push(chat("two", { platform: "youtube", userId: "1", user: "Sam" }));
  ctx.push(chat("three", { platform: "twitch", userId: "2", user: "Sam" }));
  ctx.push(chat("four", { platform: "twitch", userId: "1", user: "Renamed" })); // same viewer as "one"
  near((await sch.decide(ctx, false, false)).score, 0.45);
});

test("Scheduler: the walk takes the highest score first, so a viewer counts at their best line", async () => { // @spec SAL-DECIDE-009, SAL-DECIDE-014
  const sch = new Scheduler(salienceCfg(), rulesScorer());
  const ctx = new Context(20);
  ctx.push(from("v1", "plain"));
  ctx.push(from("v1", "a question?"));
  ctx.push(from("v1", "hey Coco", { mentionsCohost: true }));
  const d = await sch.decide(ctx, false, false);
  near(d.score, 1.0);
  assert.equal((d.focus as { text: string }).text, "hey Coco");
  assert.equal(d.reason, "mentioned");
});

test("Scheduler: equal scores go to the later event in window order, whatever the timestamps", async () => { // @spec SAL-DECIDE-009, SAL-DECIDE-014
  const sch = new Scheduler(salienceCfg(), rulesScorer());
  const ctx = new Context(20);
  const early = from("v1", "first plain");
  const late = from("v1", "second plain");
  (early as { ts: number }).ts = 2000; // the earlier arrival carries the later timestamp
  (late as { ts: number }).ts = 1000;
  ctx.push(early);
  ctx.push(late);
  const d = await sch.decide(ctx, false, false);
  assert.equal((d.focus as { text: string }).text, "second plain");
  near(d.score, 0.15);
});

test("Scheduler: speech and vision always count, repeated text included", async () => { // @spec SAL-DECIDE-010
  const sch = new Scheduler(salienceCfg(), rulesScorer());
  const ctx = new Context(20);
  ctx.push(from("v1", "hi"));
  ctx.push(vision("screen changed"));
  ctx.push(vision("screen changed"));
  ctx.push(speech("hi"));
  ctx.push(speech("hi"));
  near((await sch.decide(ctx, false, false)).score, 0.15 + 0.3 + 0.3 + 0.9 + 0.9);
});

test("Scheduler: a discounted line adds nothing, is never the focus, and is reported scored", async () => { // @spec SAL-DECIDE-007, SAL-DECIDE-013, SAL-DECIDE-014, SAL-DECIDE-015
  const sch = new Scheduler(salienceCfg(), rulesScorer());
  const ctx = new Context(20);
  ctx.push(from("v1", "why?")); // 0.55
  ctx.push(from("v1", "ok")); // 0.15, same viewer: discounted
  ctx.push(from("v2", "why?")); // 0.55, later than v1's equal line so walked first and counted
  const d = await sch.decide(ctx, false, false);
  near(d.score, 0.55);
  assert.equal(d.scored.length, 3);
  assert.equal(d.focus, ctx.unseen()[2]);
  ctx.markSeenEvents(d.scored);
  assert.equal(ctx.unseen().length, 0);
  ctx.push(from("v1", "another")); // a new burst once marked seen
  near((await sch.decide(ctx, false, false)).score, 0.15);
});

test("Scheduler: a discounted line stays discounted at every tick while unseen", async () => { // @spec SAL-DECIDE-015
  const sch = new Scheduler(salienceCfg(), rulesScorer());
  const ctx = new Context(20);
  ctx.push(from("v1", "a"));
  ctx.push(from("v1", "b"));
  for (let i = 0; i < 4; i++) near((await sch.decide(ctx, false, false)).score, 0.15);
});

test("Scheduler: idle chatter reports every unseen event scored, counted or not", async () => { // @spec SAL-DECIDE-007, SAL-DECIDE-015
  const sch = new Scheduler(salienceCfg({ idle_chatter_ms: 1 }), rulesScorer());
  const ctx = new Context(20);
  ctx.push(from("v1", "a"));
  ctx.push(from("v1", "b"));
  await new Promise((r) => setTimeout(r, 5));
  const d = await sch.decide(ctx, false, false);
  assert.equal(d.reason, "idle chatter");
  assert.equal(d.scored.length, 2);
});

test("Scheduler: counting reads and changes no reflex state", async () => { // @spec SAL-DECIDE-016
  const reflexes = new Reflexes([{ match: "raid", on: ["chat"], say: ["Raid!"], emotion: "happy", cooldown_ms: 1000 }]);
  const sch = new Scheduler(salienceCfg(), rulesScorer());
  const ctx = new Context(40);
  assert.ok(reflexes.test("chat", "raid incoming", 0)); // fires once
  for (let i = 0; i < 20; i++) ctx.push(from("v1", `raid ${i}`)); // a flood
  await sch.decide(ctx, false, false);
  assert.equal(reflexes.test("chat", "raid again", 500), undefined, "still inside its own cooldown after a decision");
  assert.ok(reflexes.test("chat", "raid again", 1001), "fires under its own cooldown only");
});
