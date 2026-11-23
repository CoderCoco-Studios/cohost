import { test } from "node:test";
import assert from "node:assert/strict";
import type { BusEvent } from "@cohost/bus";
import { Context } from "../src/index.js";

let ts = 9000;
const chat = (text: string) =>
  ({ id: String(ts), type: "chat.message", ts: ts++, source: "t", data: { platform: "twitch", user: "viewer", text, isMod: false, isSub: false, mentionsCohost: false } }) as unknown as BusEvent;
const brainCfg = (over: Record<string, unknown> = {}) =>
  ({ working_memory_events: 24, working_memory_own_lines: 4, input_limits: { speech_max_chars: 1000, vision_max_chars: 500 }, ...over });
const viewerText = { max_chars: 500, max_name_chars: 40 };
const selfTexts = (ctx: Context) => ctx.all().filter((e) => e.kind === "self").map((e) => e.text);
const unseen = (ctx: Context) => ctx.unseen().map((e) => (e as { text: string }).text);

// @spec WM-WIN-008
test("forBrain sizes the window from brain.working_memory_events", () => {
  const ctx = Context.forBrain(brainCfg({ working_memory_events: 2 }), viewerText);
  ctx.push(chat("a")); ctx.push(chat("b")); ctx.push(chat("c"));
  assert.deepEqual(unseen(ctx), ["b", "c"]);
});

// @spec WM-SEEN-004
test("releaseArrivals marks seen only what arrived during the hold", () => {
  const ctx = new Context(10);
  ctx.push(chat("before"));
  ctx.holdArrivals();
  ctx.push(chat("d1")); ctx.push(chat("d2"));
  ctx.releaseArrivals();
  ctx.push(chat("after"));
  assert.deepEqual(unseen(ctx), ["before", "after"]);
});

// @spec WM-SEEN-004
test("hold record is bounded by the window; clear empties it but keeps holding; hold restarts it; release without hold is a no-op", () => {
  const ctx = new Context(2);
  ctx.holdArrivals();
  ctx.push(chat("a")); ctx.push(chat("b")); ctx.push(chat("c"));
  ctx.releaseArrivals();
  assert.deepEqual(unseen(ctx), []);
  ctx.holdArrivals();
  ctx.push(chat("lost"));
  ctx.clear();
  ctx.push(chat("kept"));
  ctx.releaseArrivals();
  assert.deepEqual(unseen(ctx), []);
  ctx.holdArrivals(); ctx.push(chat("x")); ctx.holdArrivals(); ctx.push(chat("y"));
  ctx.releaseArrivals();
  assert.deepEqual(unseen(ctx), ["x"]);
  ctx.releaseArrivals();
  assert.deepEqual(unseen(ctx), ["x"]);
});

// @spec WM-WIN-001, WM-WIN-010
test("a chat flood leaves the newest own_lines self events in the window", () => {
  const ctx = Context.forBrain(brainCfg({ working_memory_events: 6, working_memory_own_lines: 2 }), viewerText);
  ctx.pushSelf("s1", "happy", 1, "a"); ctx.pushSelf("s2", "happy", 2, "b"); ctx.pushSelf("s3", "happy", 3, "c");
  for (let i = 0; i < 20; i++) ctx.push(chat(`c${i}`));
  assert.deepEqual(selfTexts(ctx), ["s2", "s3"]);
  assert.equal(ctx.all().length, 6);
  assert.deepEqual(unseen(ctx), ["c16", "c17", "c18", "c19"]);
});

// @spec WM-WIN-001
test("eviction drops the oldest unprotected event even when older than protected selfs, and a self push evicts too", () => {
  const ctx = Context.forBrain(brainCfg({ working_memory_events: 4, working_memory_own_lines: 1 }), viewerText);
  ctx.push(chat("old")); ctx.pushSelf("s1", "happy", 1, "a"); ctx.push(chat("x")); ctx.push(chat("y"));
  ctx.pushSelf("s2", "happy", 2, "b");
  assert.equal(ctx.all().length, 4);
  assert.deepEqual(ctx.all().map((e) => e.text), ["s1", "x", "y", "s2"]);
  assert.ok(selfTexts(ctx).includes("s2"), "newest self is kept");
  assert.ok(!ctx.all().some((e) => e.text === "old"), "oldest unprotected event dropped");
});

// @spec WM-WIN-009
test("protection is capped at max - 1 so a push still evicts", () => {
  const ctx = Context.forBrain(brainCfg({ working_memory_events: 3, working_memory_own_lines: 5 }), viewerText);
  ctx.pushSelf("s1", "happy", 1, "a"); ctx.pushSelf("s2", "happy", 2, "b"); ctx.pushSelf("s3", "happy", 3, "c");
  ctx.push(chat("c1"));
  assert.equal(ctx.all().length, 3);
  assert.deepEqual(ctx.all().map((e) => e.text), ["s2", "s3", "c1"]);
  ctx.push(chat("c2"));
  assert.deepEqual(ctx.all().map((e) => e.text), ["s2", "s3", "c2"]);
});

// @spec WM-WIN-012
test("a directly constructed Context protects no self event", () => {
  const ctx = new Context(3);
  ctx.pushSelf("s1", "happy", 1, "a");
  ctx.push(chat("a")); ctx.push(chat("b")); ctx.push(chat("c"));
  assert.deepEqual(selfTexts(ctx), []);
});

// @spec WM-WIN-011
test("forBrain applies viewerText and input_limits to push and transcript", () => {
  const ctx = Context.forBrain(brainCfg({ input_limits: { speech_max_chars: 20, vision_max_chars: 30 } }), { max_chars: 16, max_name_chars: 8 });
  const e = ctx.push(chat("x".repeat(100))) as { text: string };
  assert.equal([...e.text].length, 16);
  assert.ok(e.text.endsWith("…"));
  const s = ctx.push({ id: "s", type: "speech.heard", ts: 1, source: "t", data: { speaker: "S".repeat(50), text: "y".repeat(100), durationMs: 1 } } as unknown as BusEvent) as { text: string; speaker: string };
  assert.equal([...s.text].length, 20);
  assert.equal([...s.speaker].length, 8);
  ctx.push({ id: "v", type: "vision.summary", ts: 2, source: "t", data: { text: "z".repeat(100), changed: true } } as unknown as BusEvent);
  assert.equal([...ctx.lastVision].length, 30);
});
