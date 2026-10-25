import { test } from "node:test";
import assert from "node:assert/strict";
import type { BusEvent } from "@cohost/bus";
import { Context } from "../src/index.js";

let ts = 1000;
const ev = (type: string, data: Record<string, unknown>) => ({ id: String(ts), type, ts: ts++, source: "t", data }) as unknown as BusEvent;
const chat = (text: string, extra: Record<string, unknown> = {}) =>
  ev("chat.message", { platform: "twitch", user: "viewer", text, isMod: false, isSub: false, mentionsCohost: false, ...extra });
const vision = (text: string, changed = true) => ev("vision.summary", { text, changed });
const speech = (text: string) => ev("speech.heard", { speaker: "Streamer", text, durationMs: 500 });

test("push maps each sense into a context event, unseen", () => {
  const ctx = new Context(10);
  ctx.push(chat("hi", { mentionsCohost: true, isMod: true, isSub: true }));
  ctx.push(speech("hello"));
  assert.deepEqual(ctx.all().map((e) => ({ ...e, ts: 0 })), [
    { kind: "chat", ts: 0, user: "viewer", text: "hi", mention: true, isMod: true, isSub: true, seen: false },
    { kind: "speech", ts: 0, speaker: "Streamer", text: "hello", seen: false },
  ]);
});

test("push ignores event types that aren't senses", () => {
  const ctx = new Context(10);
  ctx.push(ev("affect.state", { valence: 0, arousal: 0, mood: "neutral" }));
  ctx.push(ev("brain.say", { id: "x", text: "ignored here", emotion: "happy" }));
  assert.equal(ctx.all().length, 0);
});

test("vision: only the latest line is kept, and an unchanged screen is already seen", () => {
  const ctx = new Context(10);
  ctx.push(vision("menu"));
  ctx.push(chat("a"));
  ctx.push(vision("boss fight"));
  assert.deepEqual(ctx.all().map((e) => e.text), ["a", "boss fight"]);
  assert.equal(ctx.lastVision, "boss fight");
  ctx.push(vision("still boss fight", false));
  const v = ctx.all().find((e) => e.kind === "vision")!;
  assert.equal(v.seen, true);
  assert.equal(ctx.lastVision, "still boss fight");
  assert.deepEqual(ctx.unseen().map((e) => e.text), ["a"]);
});

test("the window is trimmed from the oldest end, self lines included", () => {
  const ctx = new Context(3);
  ctx.push(chat("1"));
  ctx.push(chat("2"));
  ctx.pushSelf("me", "happy");
  ctx.push(chat("3"));
  assert.deepEqual(ctx.all().map((e) => e.text), ["2", "me", "3"]);
  ctx.pushSelf("me again", "neutral");
  assert.deepEqual(ctx.all().map((e) => e.text), ["me", "3", "me again"]);
});

test("self lines are always seen; markSeen marks everything; clear empties the window but keeps lastVision", () => {
  const ctx = new Context(10);
  ctx.pushSelf("me", "smug");
  assert.equal(ctx.unseen().length, 0);
  ctx.push(chat("a"));
  ctx.push(vision("v"));
  assert.equal(ctx.unseen().length, 2);
  ctx.markSeen();
  assert.equal(ctx.unseen().length, 0);
  ctx.clear();
  assert.equal(ctx.all().length, 0);
  assert.equal(ctx.last(), undefined);
  assert.equal(ctx.lastVision, "v");
});

test("markSeenEvents ignores events that are no longer (or never were) in the window", () => {
  const ctx = new Context(1);
  ctx.push(chat("old"));
  const old = ctx.last()!;
  ctx.push(chat("new")); // trims "old"
  ctx.markSeenEvents([old, { kind: "chat", ts: 0, user: "x", text: "stranger", mention: false, isMod: false, isSub: false, seen: false }]);
  assert.deepEqual(ctx.unseen().map((e) => e.text), ["new"]);
});

test("transcript renders each kind with the tags the LLM stop sequences rely on", () => {
  const ctx = new Context(10);
  ctx.push(chat("gg", { isMod: true }));
  ctx.push(chat("lol"));
  ctx.push(speech("did you see that"));
  ctx.push(vision("a boss appears"));
  ctx.pushSelf("I saw it!", "surprised");
  assert.equal(
    ctx.transcript("Coco"),
    [
      "[chat] viewer (mod): gg",
      "[chat] viewer: lol",
      "[voice] Streamer: did you see that",
      "[screen] a boss appears",
      "Coco: [surprised] I saw it!",
    ].join("\n"),
  );
  assert.equal(new Context(5).transcript("Coco"), "");
});

test("injection flags are retained on chat, speech and vision; real events and self carry none", () => {
  const ctx = new Context(10);
  ctx.push(chat("a", { injected: true, remember: false }));
  ctx.push(speech("b"));
  ctx.push(ev("speech.heard", { speaker: "S", text: "c", durationMs: 1, injected: true, remember: true }));
  ctx.push(ev("vision.summary", { text: "d", changed: true, injected: true, remember: false }));
  ctx.pushSelf("e", "happy");
  const [c, real, sp, v, self] = ctx.all() as unknown as Record<string, unknown>[];
  assert.deepEqual([c!.injected, c!.remember], [true, false]);
  assert.equal("injected" in real! || "remember" in real!, false);
  assert.deepEqual([sp!.injected, sp!.remember], [true, true]);
  assert.deepEqual([v!.injected, v!.remember], [true, false]);
  assert.equal("injected" in self! || "remember" in self!, false);
});
