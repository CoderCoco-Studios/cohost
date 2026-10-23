import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfigSchema, EMOTIONS } from "@cohost/config";
import { Context } from "@cohost/working-memory";
import { buildMessages, type Focus } from "../src/prompt.js";

const cfg = ConfigSchema.parse({
  cohost: { name: "Coco", streamer: "Chris", timezone: "UTC" },
  llm: { model: "m", embed_model: "e" },
  vision: { model: "v", obs: {} },
  chat: { twitch: {} },
  brain: {},
  voice: {},
  avatar: { vtube_studio: { host: "h", port: 1 }, vmc: { host: "h", port: 1 } },
  ears: { discord: {} },
  dashboard: {},
});

const build = (over: Partial<Parameters<typeof buildMessages>[0]> = {}) =>
  buildMessages({ cfg, personality: "  You are Coco.  \n", ctx: new Context(10), memories: [], focus: { reason: "engaged", score: 1 }, ...over });
const system = (over: Parameters<typeof build>[0] = {}) => build(over)[0]!.content;
const user = (over: Parameters<typeof build>[0] = {}) => build(over)[1]!.content;

test("buildMessages: one system message (personality first) and one user message", () => {
  const msgs = build();
  assert.deepEqual(msgs.map((m) => m.role), ["system", "user"]);
  assert.ok(msgs[0]!.content.startsWith("You are Coco.\n"));
  assert.match(msgs[0]!.content, /- Streamer: Chris\n- Your name: Coco/);
  for (const e of EMOTIONS) assert.ok(msgs[0]!.content.includes(`[${e}]`), `emotion ${e} offered`);
});

test("buildMessages: optional lines only appear when there is something to say", () => {
  const bare = system();
  assert.doesNotMatch(bare, /On screen right now|current mood|Things you remember/);
  const ctx = new Context(10);
  ctx.lastVision = "a boss fight";
  const s = system({ ctx, viewerNote: "bob is new here (first message).", mood: { valence: 0, arousal: 0, mood: "neutral" } });
  assert.match(s, /- On screen right now: a boss fight/);
  assert.match(s, /- bob is new here \(first message\)\./);
  assert.match(s, /- Your current mood: even, relaxed \(neutral\)/);
});

test("buildMessages: mood numbers become words", () => {
  const mood = (valence: number, arousal: number) => /current mood: ([^(]+)\(/.exec(system({ mood: { valence, arousal, mood: "x" as never } }))![1]!.trim();
  assert.equal(mood(0.5, 0.7), "in a great mood, buzzing");
  assert.equal(mood(0.2, 0.4), "cheerful, engaged");
  assert.equal(mood(0, 0.1), "even, relaxed");
  assert.equal(mood(-0.2, 0.1), "a bit down, relaxed");
  assert.equal(mood(-0.5, 0.1), "fed up, relaxed");
});

test("buildMessages: recalled memories are dated and attributed", () => {
  const s = system({ memories: [{ ts: Date.UTC(2026, 0, 2, 12), kind: "chat", who: "bob", text: "I love speedruns" }] });
  assert.match(s, /## Things you remember.*\n- \(2026-01-02\) bob: I love speedruns/);
});

test("buildMessages: the transcript goes in the user turn, or (quiet) when empty", () => {
  assert.match(user(), /^## Recent transcript\n\(quiet\)\n\n/);
  const ctx = new Context(10);
  ctx.pushSelf("hello", "happy");
  assert.match(user({ ctx }), /^## Recent transcript\nCoco: \[happy\] hello\n\n/);
});

test("buildMessages: the closing nudge depends on why salience fired and what it focused on", () => {
  const nudge = (focus: Focus) => user({ focus }).split("\n\n").pop()!;
  assert.match(nudge({ reason: "idle chatter", score: 0 }), /^It's been quiet\..* Coco:$/);
  assert.equal(nudge({ reason: "engaged", score: 1 }), "Coco:");
  assert.equal(nudge({ reason: "mentioned", score: 1, focus: { kind: "chat", who: "bob", text: "hi", mention: true } }), "bob is talking to you. Answer them directly. Coco:");
  assert.match(nudge({ reason: "engaged", score: 1, focus: { kind: "speech", who: "Chris", text: "wow", mention: false } }), /^Chris just said that out loud\./);
  assert.match(nudge({ reason: "engaged", score: 1, focus: { kind: "chat", who: "bob", text: "hi", mention: false } }), /^Respond to the chat above/);
  assert.match(nudge({ reason: "engaged", score: 1, focus: { kind: "vision", text: "x", mention: false } }), /^Something changed on screen\./);
});
