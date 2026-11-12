import { test } from "node:test";
import assert from "node:assert/strict";
import type { BusEvent } from "@cohost/bus";
import { Context } from "../src/index.js";

let ts = 5000;
const chat = (text: string) =>
  ({ id: String(ts), type: "chat.message", ts: ts++, source: "t", data: { platform: "twitch", user: "viewer", text, isMod: false, isSub: false, mentionsCohost: false } }) as unknown as BusEvent;

// @spec WM-PUSH-007
test("pushSelf with an id keeps it on the self event without rendering it; without one the event has no id key", () => {
  const ctx = new Context(10);
  ctx.pushSelf("plain", "happy", 1000);
  ctx.pushSelf("hello", "happy", 1000, "say-1");
  const [a, b] = ctx.all();
  assert.equal("id" in a!, false);
  assert.equal((b as { id?: string }).id, "say-1");
  assert.equal(ctx.transcript("Coco"), "Coco: [happy] plain\nCoco: [happy] hello");
});

// @spec WM-WIN-007
test("hasSelf: true only while a self event with that id is in the window", () => {
  const ctx = new Context(2);
  ctx.pushSelf("one", "happy", 1000, "a");
  ctx.push(chat("not self"));
  assert.equal(ctx.hasSelf("a"), true);
  assert.equal(ctx.hasSelf("b"), false);
  ctx.push(chat("pushes it out"));
  assert.equal(ctx.hasSelf("a"), false); // trimmed away
  ctx.pushSelf("two", "happy", 1000, "b");
  ctx.clear();
  assert.equal(ctx.hasSelf("b"), false);
});

// @spec WM-PUSH-008
test("markFallback records the fallback text in place, keeping position and seen state; an unknown id changes nothing", () => {
  const ctx = new Context(10);
  ctx.pushSelf("meant", "happy", 1000, "a");
  ctx.push(chat("later"));
  const before = ctx.all().map((e) => ({ ...e }));
  assert.equal(ctx.markFallback("nope", "x"), false);
  assert.deepEqual(ctx.all().map((e) => ({ ...e })), before);
  assert.equal(ctx.markFallback("a", "heard"), true);
  const [s, c] = ctx.all();
  assert.equal(s!.kind, "self");
  assert.equal((s as { fallback?: string }).fallback, "heard");
  assert.equal(s!.seen, true);
  assert.equal(c!.kind, "chat");
  assert.equal(c!.seen, false);
});

// @spec WM-TRANS-010
test("transcript: a marked self line shows the fallback with a note quoting the failed line, on one line; unmarked lines are unchanged", () => {
  const ctx = new Context(10);
  ctx.pushSelf("plain", "sad", 1000);
  ctx.pushSelf("meant\nto say\r\nthis", "happy", 1000, "a");
  ctx.markFallback("a", "oops\nlol");
  assert.equal(
    ctx.transcript("Coco"),
    'Coco: [sad] plain\nCoco: [happy] oops lol [your line "meant to say  this" failed to play; this came out instead]',
  );
  assert.equal(ctx.transcript("Coco").split("\n").length, 2);
});
