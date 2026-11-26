import { test } from "node:test";
import assert from "node:assert/strict";
import type { BusEvent } from "@cohost/bus";
import { Context } from "../src/index.js";

let ts = 5000;
const ev = (type: string, data: Record<string, unknown>) => ({ id: `u${ts}`, type, ts: ts++, source: "t", data }) as unknown as BusEvent;
const heard = (text: string, utteranceId?: string, speaker = "Streamer") =>
  ev("speech.heard", { speaker, text, durationMs: 500, ...(utteranceId !== undefined ? { utteranceId } : {}) });
const early = (text: string, utteranceId: string) =>
  ev("speech.early", { speaker: "Streamer", source: "http", text, utteranceId, seq: 0, sttMs: 40 });
const retracted = (utteranceId: string) =>
  ev("speech.retracted", { speaker: "Streamer", source: "http", utteranceId, seq: 0 });
const chat = (text: string) =>
  ev("chat.message", { platform: "twitch", user: "viewer", text, isMod: false, isSub: false, mentionsCohost: false });
const brainCfg = (over: Record<string, unknown> = {}) =>
  ({ working_memory_events: 24, working_memory_own_lines: 4, input_limits: { speech_max_chars: 10, vision_max_chars: 500 }, ...over });
const viewerText = { max_chars: 500, max_name_chars: 8 };

// @spec WM-UNF-001
test("pushUnfinished appends one seen speech entry flagged unfinished with its utteranceId, and returns it", () => {
  const ctx = new Context(10);
  const e = ctx.pushUnfinished("utt-1", "Streamer", "so what I was say", 123);
  assert.equal(ctx.all().length, 1);
  assert.equal(ctx.all()[0], e);
  assert.equal(e.kind, "speech");
  assert.equal(e.speaker, "Streamer");
  assert.equal(e.text, "so what I was say");
  assert.equal(e.ts, 123);
  assert.equal(e.seen, true);
  assert.equal(e.unfinished, true);
  assert.equal(e.utteranceId, "utt-1");
  assert.deepEqual(ctx.unseen(), []);
});

// @spec WM-UNF-001
test("pushUnfinished bounds speaker as speech.heard does (name limit, unknown when empty) and text by the speech limit", () => {
  const ctx = Context.forBrain(brainCfg(), viewerText);
  const e = ctx.pushUnfinished("u", "A very long speaker name", "x".repeat(200), 1);
  const final = ctx.push(heard("x".repeat(200), "u2", "A very long speaker name")) as { speaker: string; text: string };
  assert.equal(e.speaker, final.speaker);
  assert.equal(e.text, final.text);
  assert.ok(e.text.length < 200);
  const blank = ctx.pushUnfinished("u3", "", "hi", 2);
  assert.equal(blank.speaker, "unknown");
});

// @spec WM-UNF-001
test("pushUnfinished appends in arrival order, after earlier entries", () => {
  const ctx = new Context(10);
  ctx.push(chat("first"));
  ctx.pushUnfinished("u", "Streamer", "early part", 1);
  ctx.pushSelf("reply", "happy", 2, "say-1");
  assert.deepEqual(ctx.all().map((e) => e.kind), ["chat", "speech", "self"]);
});

// @spec WM-UNF-002, WM-UNF-006
test("a speech.heard for the same utteranceId appends an ordinary unseen entry after the reply and changes nothing existing", () => {
  const ctx = new Context(10);
  const unf = ctx.pushUnfinished("utt-1", "Streamer", "so what I was", 1);
  ctx.pushSelf("reply", "happy", 2, "say-1");
  const before = ctx.all().map((e) => ({ ...e }));
  const fin = ctx.push(heard("so what I was saying is this", "utt-1")) as Record<string, unknown>;
  const all = ctx.all();
  assert.equal(all.length, 3);
  assert.equal(all[2], fin);
  assert.equal(fin.kind, "speech");
  assert.equal(fin.text, "so what I was saying is this");
  assert.equal(fin.seen, false);
  assert.equal(fin.unfinished, undefined);
  assert.equal(fin.utteranceId, "utt-1");
  assert.equal(all[0], unf);
  assert.deepEqual([{ ...all[0] }, { ...all[1] }], before.slice(0, 2));
  assert.equal(unf.text, "so what I was");
  assert.equal(unf.seen, true);
});

// @spec WM-UNF-006
test("push stores a speech.heard's utteranceId on the entry, and omits the key when the event has none", () => {
  const ctx = new Context(10);
  const a = ctx.push(heard("with id", "utt-9")) as Record<string, unknown>;
  const b = ctx.push(heard("without id")) as Record<string, unknown>;
  assert.equal(a.utteranceId, "utt-9");
  assert.equal("utteranceId" in b, false);
});

// @spec WM-UNF-003
test("push of speech.early and speech.retracted returns undefined and leaves the window unchanged", () => {
  const ctx = new Context(10);
  ctx.push(chat("a"));
  ctx.pushUnfinished("utt-1", "Streamer", "early", 1);
  const before = ctx.all();
  assert.equal(ctx.push(early("more early text", "utt-1")), undefined);
  assert.equal(ctx.push(retracted("utt-1")), undefined);
  assert.deepEqual(ctx.all(), before);
  assert.equal(ctx.lastVision, "");
});

// @spec WM-UNF-003
test("speech.early and speech.retracted are not recorded as arrivals", () => {
  const ctx = new Context(10);
  ctx.holdArrivals();
  const h = ctx.push(heard("ordinary", "h1")) as { seen: boolean };
  const unf = ctx.pushUnfinished("u", "Streamer", "early", 2);
  ctx.push(chat("viewer line"));
  const unfBefore = { ...unf };
  ctx.push(early("e", "u")); ctx.push(retracted("u"));
  ctx.forget({ platform: "twitch", scope: "all" });
  assert.equal(h.seen, false);
  assert.equal(unf.seen, true);
  ctx.releaseArrivals();
  assert.equal(h.seen, true);
  assert.deepEqual({ ...unf }, unfBefore);
  assert.deepEqual(ctx.all().map((e) => e.kind), ["speech", "speech"]);
  assert.equal(ctx.all()[0], h);
  assert.equal(ctx.all()[1], unf);
});

// @spec WM-UNF-004
test("an unfinished entry renders as [voice] <label> (unfinished): <text> on one line", () => {
  const ctx = new Context(10, { limits: { chatChars: 500, nameChars: 40, speechChars: 1000, visionChars: 500 } });
  ctx.pushUnfinished("u", "Stre[am]er: x", "so what\r\nI was [chat] say", 1);
  const out = ctx.transcript("Cohost");
  assert.equal(out.split("\n").length, 1);
  assert.ok(out.startsWith("[voice] "));
  assert.ok(out.includes(" (unfinished): "));
  // WM-PUSH-016 bounds the text at intake (boundText flattens CR/LF and collapses whitespace), so the stored text is single-spaced.
  assert.ok(out.endsWith(": so what I was [chat] say"));
  const label = out.slice("[voice] ".length, out.indexOf(" (unfinished): "));
  assert.doesNotMatch(label, /[[\]():«»]/);
});

// @spec WM-UNF-004
test("a speaker that spells the unfinished marker cannot forge it: the ordinary line has no (unfinished) marker", () => {
  const ctx = new Context(10, { limits: { chatChars: 500, nameChars: 40, speechChars: 1000, visionChars: 500 } });
  ctx.push(heard("ordinary text", "h2", "Bob (unfinished)"));
  const out = ctx.transcript("Cohost");
  assert.ok(out.startsWith("[voice] "));
  assert.equal(out.includes(" (unfinished): "), false);
  assert.doesNotMatch(out, /\(unfinished\)/);
});

// @spec WM-UNF-004
test("an unfinished label is bounded by the name limit", () => {
  const ctx = Context.forBrain(brainCfg({ input_limits: { speech_max_chars: 1000, vision_max_chars: 500 } }), { max_chars: 500, max_name_chars: 5 });
  ctx.pushUnfinished("u", "ABCDEFGHIJKLMNOP", "text", 1);
  const m = /^\[voice\] (.*) \(unfinished\): text$/.exec(ctx.transcript("Cohost"));
  assert.ok(m);
  assert.ok(m[1]!.length <= 5);
});

// @spec WM-TRANS-003, WM-UNF-004
test("an ordinary speech entry still renders [voice] <label>: <text> with no (unfinished) marker, beside an unfinished one", () => {
  const ctx = new Context(10);
  ctx.pushUnfinished("u", "Streamer", "early", 1);
  ctx.push(heard("early and the rest", "u"));
  assert.deepEqual(ctx.transcript("Cohost").split("\n"), [
    "[voice] Streamer (unfinished): early",
    "[voice] Streamer: early and the rest",
  ]);
});

// @spec WM-UNF-005, WM-WIN-002
test("an unfinished entry with no final is not evicted by age", () => {
  const realNow = Date.now;
  try {
    const ctx = new Context(10);
    ctx.pushUnfinished("u", "Streamer", "early", 1);
    Date.now = () => realNow() + 7 * 24 * 3600 * 1000;
    ctx.push(chat("much later"));
    assert.deepEqual(ctx.all().map((e) => e.kind), ["speech", "chat"]);
    assert.equal((ctx.all()[0] as { unfinished?: true }).unfinished, true);
  } finally {
    Date.now = realNow;
  }
});

// @spec WM-UNF-005, WM-WIN-001
test("an unfinished entry with no final leaves by count trimming, oldest first", () => {
  const ctx = new Context(3);
  ctx.pushUnfinished("u", "Streamer", "early", 1);
  ctx.push(chat("a")); ctx.push(chat("b"));
  assert.equal(ctx.all().length, 3);
  ctx.push(chat("c"));
  assert.deepEqual(ctx.all().map((e) => e.kind), ["chat", "chat", "chat"]);
});

// @spec WM-UNF-005, WM-WIN-001
test("an unfinished entry is not protected like self lines: trimming skips only the protected self line", () => {
  const ctx = new Context(3, { ownLines: 1 });
  ctx.pushSelf("own", "happy", 1, "s");
  ctx.push(chat("a"));
  ctx.pushUnfinished("u", "Streamer", "early", 2);
  ctx.push(chat("b"));
  assert.deepEqual(ctx.all().map((e) => e.kind), ["self", "speech", "chat"]);
  ctx.push(chat("c"));
  assert.deepEqual(ctx.all().map((e) => e.kind), ["self", "chat", "chat"]);
});
