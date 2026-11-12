import { test } from "node:test";
import assert from "node:assert/strict";
import type { BusEvent } from "@cohost/bus";
import { Context } from "../src/index.js";

let ts = 9000;
const chat = (text: string) =>
  ({ id: String(ts), type: "chat.message", ts: ts++, source: "t", data: { platform: "twitch", user: "viewer", text, isMod: false, isSub: false, mentionsCohost: false } }) as unknown as BusEvent;
const unseen = (ctx: Context) => ctx.unseen().map((e) => (e as { text: string }).text);

// @spec WM-WIN-008
test("forBrain sizes the window from brain.working_memory_events", () => {
  const ctx = Context.forBrain({ working_memory_events: 2 });
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
