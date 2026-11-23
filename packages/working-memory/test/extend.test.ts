import { test } from "node:test";
import assert from "node:assert/strict";
import type { BusEvent } from "@cohost/bus";
import { Context, type ContextEvent } from "../src/index.js";

const chat = (text: string) =>
  ({ id: `c-${text}`, type: "chat.message", ts: 1, source: "t", data: { platform: "twitch", user: "viewer", text, isMod: false, isSub: false, mentionsCohost: false } }) as unknown as BusEvent;

type SelfEvent = Extract<ContextEvent, { kind: "self" }>;
const selfOf = (ctx: Context, id: string): SelfEvent => ctx.all().find((e) => e.kind === "self" && e.id === id) as SelfEvent;

// @spec WM-PUSH-021
test("extendSelf appends the next clause after one space without moving the event or changing seen", () => {
  const ctx = new Context(10);
  ctx.pushSelf("First clause.", "happy", 1000, "a");
  ctx.push(chat("later"));
  assert.equal(ctx.extendSelf("a", 1, "Second."), true);
  assert.equal(ctx.extendSelf("a", 2, "Third."), true);
  const all = ctx.all();
  assert.equal(all[0]!.kind, "self");
  assert.equal(selfOf(ctx, "a").text, "First clause. Second. Third.");
  assert.equal(all[0]!.seen, true);
  assert.equal(all[1]!.kind, "chat");
  assert.equal(all[1]!.seen, false);
  assert.match(ctx.transcript("Coco"), /^Coco: \[happy\] First clause\. Second\. Third\.\n/);
});

// @spec WM-PUSH-022
test("extendSelf changes nothing and returns false for an unknown id, a duplicate, a gap, an out-of-order seq or empty text", () => {
  const ctx = new Context(10);
  ctx.pushSelf("one", "happy", 1000, "a");
  assert.equal(ctx.extendSelf("nope", 1, "x"), false);
  assert.equal(ctx.extendSelf("a", 2, "gap"), false); // the first clause after pushSelf is seq 1
  assert.equal(ctx.extendSelf("a", 0, "zero"), false);
  assert.equal(ctx.extendSelf("a", 1, ""), false);
  assert.equal(ctx.extendSelf("a", 1, "two"), true);
  assert.equal(ctx.extendSelf("a", 1, "dup"), false);
  assert.equal(ctx.extendSelf("a", 4, "skip"), false);
  assert.equal(ctx.extendSelf("a", 2, "three"), true);
  assert.equal(ctx.extendSelf("a", 1, "late"), false);
  assert.equal(selfOf(ctx, "a").text, "one two three");
  assert.equal(ctx.extendSelf("a", 3, ""), false); // a refused empty clause does not advance seq
  assert.equal(ctx.extendSelf("a", 3, "four"), true);
});

// @spec WM-PUSH-022
test("extendSelf returns false for an event that left the window", () => {
  const ctx = new Context(2);
  ctx.pushSelf("one", "happy", 1000, "a");
  ctx.push(chat("x"));
  ctx.push(chat("y"));
  assert.equal(ctx.hasSelf("a"), false);
  assert.equal(ctx.extendSelf("a", 1, "two"), false);
});

// @spec WM-PUSH-023
test("extendSelf leaves fallback, heard and emotion as they are", () => {
  const ctx = new Context(10);
  ctx.pushSelf("one", "sad", 1000, "a");
  ctx.markHeard("a", "heard text");
  ctx.markFallback("a", "fallback text");
  assert.equal(ctx.extendSelf("a", 1, "two"), true);
  const e = selfOf(ctx, "a");
  assert.equal(e.fallback, "fallback text");
  assert.equal(e.heard, "heard text");
  assert.equal(e.emotion, "sad");
  assert.equal(e.text, "one two");
});

// @spec WM-PUSH-024
test("a self event's text is its clauses in order joined by one space; a pushSelf-only event keeps its text as given", () => {
  const ctx = new Context(10);
  ctx.pushSelf("solo line", "happy", 1000, "s");
  ctx.pushSelf("a", "happy", 1000, "b");
  ctx.extendSelf("b", 1, "b");
  ctx.extendSelf("b", 2, "c");
  assert.equal(selfOf(ctx, "s").text, "solo line");
  assert.equal(selfOf(ctx, "b").text, "a b c");
});

// @spec WM-PUSH-021, WM-PUSH-024
test("a streamed event keeps its position among the other self events when it grows", () => {
  const ctx = new Context(10);
  ctx.pushSelf("a", "happy", 1000, "x");
  ctx.pushSelf("other", "happy", 1000, "y");
  ctx.extendSelf("x", 1, "b");
  assert.deepEqual(ctx.all().map((e) => e.kind === "self" && e.id), ["x", "y"]);
});

// @spec WM-PUSH-025
test("markFallback with a seq above 0 records the clauses before seq followed by the fallback text", () => {
  const ctx = new Context(10);
  ctx.pushSelf("c0", "happy", 1000, "a");
  ctx.extendSelf("a", 1, "c1");
  ctx.extendSelf("a", 2, "c2");
  ctx.extendSelf("a", 3, "c3");
  assert.equal(ctx.markFallback("a", "oops", 2), true);
  const e = selfOf(ctx, "a");
  assert.equal(e.fallback, "c0 c1 oops");
  assert.equal(e.text, "c0 c1 c2 c3");
  assert.equal(e.seen, true);
  assert.equal(ctx.markFallback("nope", "x", 2), false);
});

// @spec WM-PUSH-008
test("markFallback with seq 0 or no seq is the whole-line mark", () => {
  const ctx = new Context(10);
  ctx.pushSelf("c0", "happy", 1000, "a");
  ctx.extendSelf("a", 1, "c1");
  ctx.pushSelf("d0", "happy", 1000, "b");
  assert.equal(ctx.markFallback("a", "whole", 0), true);
  assert.equal(ctx.markFallback("b", "plain"), true);
  assert.equal(selfOf(ctx, "a").fallback, "whole");
  assert.equal(selfOf(ctx, "b").fallback, "plain");
});

// @spec WM-TRANS-015
test("transcript: a later-clause fallback quotes only the clauses from seq on, on one line", () => {
  const ctx = new Context(10);
  ctx.pushSelf("first\nclause", "happy", 1000, "a");
  ctx.extendSelf("a", 1, "second\r\nclause");
  ctx.extendSelf("a", 2, "third");
  ctx.markFallback("a", "oops\nlol", 1);
  assert.equal(
    ctx.transcript("Coco"),
    'Coco: [happy] first clause oops lol [the rest of your line "second  clause third" failed to play; this came out instead]',
  );
  assert.equal(ctx.transcript("Coco").split("\n").length, 1);
});

// @spec WM-TRANS-010
test("transcript: a whole-line fallback on a streamed line quotes every clause, with seq 0 or none", () => {
  const ctx = new Context(10);
  ctx.pushSelf("c0", "happy", 1000, "a");
  ctx.extendSelf("a", 1, "c1");
  const note = 'Coco: [happy] oops [your line "c0 c1" failed to play; this came out instead]';
  ctx.markFallback("a", "oops");
  assert.equal(ctx.transcript("Coco"), note);
  ctx.markFallback("a", "oops", 0);
  assert.equal(ctx.transcript("Coco"), note);
});

// @spec WM-PUSH-025, WM-TRANS-015
test("a markFallback seq past the clauses held is kept, and clauses that arrive later render on the right side of it", () => {
  const ctx = new Context(10);
  ctx.pushSelf("c0", "happy", 1000, "a");
  ctx.extendSelf("a", 1, "c1");
  assert.equal(ctx.markFallback("a", "fb", 3), true);
  assert.equal(ctx.transcript("Coco"), 'Coco: [happy] c0 c1 fb [the rest of your line "" failed to play; this came out instead]');
  assert.equal(ctx.extendSelf("a", 2, "c2"), true);
  assert.equal(ctx.transcript("Coco"), 'Coco: [happy] c0 c1 c2 fb [the rest of your line "" failed to play; this came out instead]');
  assert.equal(ctx.extendSelf("a", 3, "c3"), true);
  assert.equal(ctx.transcript("Coco"), 'Coco: [happy] c0 c1 c2 fb [the rest of your line "c3" failed to play; this came out instead]');
});
