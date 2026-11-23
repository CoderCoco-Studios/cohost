import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ModuleSchema } from "@cohost/config";
import { Module } from "@cohost/modules";
import { FakeBus, event, recordingLog, silentLog, testConfig, waitFor } from "@cohost/testing";
import { boundText } from "@cohost/shared/untrusted";
import { Affect } from "../src/affect.js";
import { appraiseRules, type AppraiseInput, type AppraiseOutput } from "../src/appraise.js";

const cfg = testConfig({ brain: { affect: { baseline_valence: 0, half_life_ms: 10_000_000 } } });

/** `fetch` stubs installed by `setup("http")`, restored after each test. */
const stubs: { mock: { restore(): void } }[] = [];
afterEach(() => { for (const s of stubs.splice(0)) s.mock.restore(); });

function setup(kind: "rules" | "http" = "rules", now?: () => number) {
  const bus = new FakeBus();
  const mod = new Module<AppraiseInput, AppraiseOutput>(
    "a", ModuleSchema.parse(kind === "http" ? { kind, url: "http://appraiser.test/affect" } : {}), cfg.llm,
    {
      rules: appraiseRules,
      http: { validate: (raw) => {
        const r = raw as Partial<AppraiseOutput>;
        return typeof r.valence_delta === "number" && typeof r.arousal_delta === "number" ? { valence_delta: r.valence_delta, arousal_delta: r.arousal_delta } : undefined;
      } },
    }, silentLog,
  );
  const seen: AppraiseInput[] = [];
  let release: (() => void) | undefined;
  if (kind === "http") {
    // Stand-in for a slow model server: the real http hook path posts to a stubbed `fetch`; each call waits until the
    // test lets it go, then answers a valence nudge.
    stubs.push(mock.method(globalThis, "fetch", async (_url: unknown, init?: { body?: unknown }) => {
      seen.push(JSON.parse(String(init?.body)) as AppraiseInput);
      await new Promise<void>((r) => (release = r));
      return new Response(JSON.stringify({ valence_delta: 0.1, arousal_delta: 0 }));
    }));
  }
  const affect = new Affect({ cfg, bus, appraiser: mod, log: silentLog, now });
  return { affect, bus, seen, next: () => release?.() };
}
/** A fake monotonic clock to inject as `now`; `tick` steps it. */
const fakeClock = (start = 1_000_000) => { let t = start; return { now: () => t, tick: (ms: number) => { t += ms; } }; };
const chat = (text: string, extra: Record<string, unknown> = {}) =>
  event("chat.message", { platform: "twitch", user: "bob", text, isMod: false, isSub: false, mentionsCohost: false, ...extra });
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

test("chat and speech are appraised with the word lists (rules kind)", () => { // @spec AFF-IN-002, AFF-IN-003, AFF-HOOK-004
  const { affect } = setup();
  affect.onEvent(chat("lol that was clutch"));
  assert.ok(affect.mood.valence > 0);
  assert.equal(affect.mood.cause, "chat: bob");
  const v = affect.mood.valence;
  affect.onEvent(event("speech.heard", { speaker: "Chris", text: "this is trash", durationMs: 900 }));
  assert.ok(affect.mood.valence < v);
  assert.equal(affect.mood.cause, "voice: Chris");
});

test("subs, screen changes and the co-host's own lines nudge the mood", () => { // @spec AFF-IN-004, AFF-IN-005, AFF-IN-006
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

test("forget_context snaps the mood back to baseline", () => { // @spec AFF-IN-007
  const { affect } = setup();
  for (let i = 0; i < 5; i++) affect.onEvent(chat("LOL POGGERS!!!"));
  affect.onEvent(event("control", { cmd: "forget_context" }));
  assert.ok(near(affect.mood.valence, 0));
  assert.ok(near(affect.mood.arousal, 0.1));
  assert.equal(affect.mood.cause, "reset");
});

test("publish: only when the state moved, plus a 15 s heartbeat", () => { // @spec AFF-PUB-001, AFF-PUB-002, AFF-PUB-003
  const clock = fakeClock();
  {
    const { affect, bus } = setup("rules", clock.now);
    affect.publish();
    affect.publish();
    assert.equal(bus.of("affect.state").length, 1);
    affect.onEvent(chat("lol nice"));
    affect.publish();
    assert.equal(bus.of("affect.state").length, 2);
    assert.ok(bus.of("affect.state")[1]!.valence > 0);
    clock.tick(14_000);
    affect.publish();
    assert.equal(bus.of("affect.state").length, 2);
    clock.tick(1_000);
    affect.publish();
    assert.equal(bus.of("affect.state").length, 3);
  }
});

test("mood decay measures elapsed time, not the wall clock: a clock stepped back neither amplifies nor freezes the mood", () => { // @spec AFF-MOOD-003
  const c = testConfig({ brain: { affect: { baseline_valence: 0, half_life_ms: 45_000 } } });
  const mod = new Module<AppraiseInput, AppraiseOutput>("a", ModuleSchema.parse({}), c.llm, { rules: appraiseRules }, silentLog);
  const affect = new Affect({ cfg: c, bus: new FakeBus(), appraiser: mod, log: silentLog });
  affect.mood.nudge(0.5, 0, "test");
  const peak = affect.mood.valence;
  const realNow = Date.now.bind(Date);
  const stepped = mock.method(Date, "now", () => realNow() - 25_000); // e.g. an NTP / VM time-sync step
  try {
    affect.mood.tick();
  } finally { stepped.mock.restore(); }
  assert.ok(affect.mood.valence <= peak, `valence ${affect.mood.valence} grew past ${peak}`);
});

test("llm/http kind: lines queue for the slow appraiser instead of blocking the handler", async () => { // @spec AFF-HOOK-005
  const { affect, seen, next } = setup("http");
  affect.onEvent(chat("what a great play", { userId: "u1" }));
  affect.onEvent(chat("love this game", { userId: "u2" }));
  assert.equal(seen.length, 1, "one at a time");
  assert.equal(affect.mood.valence, 0, "nothing applied yet");
  next();
  // The answer travels through a Response body and the hook's await chain, which a fixed one-tick wait does not cover on a
  // loaded machine; wait for what the test asserts on (the first line applied and the queued line sent) instead.
  await waitFor(() => seen.length === 2 && near(affect.mood.valence, 0.1), "the first line applied and the queued line sent");
  assert.ok(near(affect.mood.valence, 0.1));
  assert.equal(seen.length, 2);
  assert.ok(near(seen[1]!.valence, 0.1), "the queued line is appraised against the mood as it is now");
  next();
  await affect.settled();
  assert.ok(near(affect.mood.valence, 0.2));
});

test("llm/http kind: a too-short line skips the model; a mention never does", async () => { // @spec AFF-HOOK-007
  const { affect, seen, next } = setup("http");
  affect.onEvent(chat("gg"));
  assert.equal(seen.length, 0);
  assert.ok(affect.mood.valence > 0, "rules applied inline");
  affect.onEvent(chat("hi", { mentionsCohost: true, userId: "u2" }));
  assert.equal(seen.length, 1);
  next();
  await affect.settled();
});

test("llm/http kind: when appraisal falls behind, the oldest waiting lines are dropped", async () => { // @spec AFF-HOOK-006
  const { affect, seen, next } = setup("http");
  for (let i = 0; i < 12; i++) affect.onEvent(chat(`line number ${i}`, { userId: `u${i}` }));
  // #0 is in flight; of #1..#11 only the newest 8 are kept.
  for (let i = 0; i < 12 && seen.length <= 9; i++) { next(); await new Promise((r) => setImmediate(r)); }
  await affect.settled();
  assert.deepEqual(seen.map((s) => s.text), ["line number 0", ...[4, 5, 6, 7, 8, 9, 10, 11].map((n) => `line number ${n}`)]);
});

test("pause: events stop nudging the mood while paused; resume restores; other targets ignored", () => { // @spec AFF-CTRL-001, AFF-CTRL-002, AFF-CTRL-004
  const { affect } = setup();
  affect.onEvent(event("control", { cmd: "pause", target: "voice" })); // not for us
  affect.onEvent(chat("lol clutch"));
  const v1 = affect.mood.valence;
  assert.ok(v1 > 0);

  affect.onEvent(event("control", { cmd: "pause", target: "affect" }));
  affect.onEvent(chat("lol clutch"));
  affect.onEvent(event("vision.summary", { text: "x", changed: true }));
  assert.equal(affect.mood.valence, v1);

  affect.onEvent(event("control", { cmd: "resume" }));
  affect.onEvent(chat("lol clutch again", { userId: "u2" }));
  assert.ok(affect.mood.valence > v1);
});

test("pause: decay continues while paused", () => { // @spec AFF-CTRL-003
  const { affect } = setup();
  affect.onEvent(chat("lol clutch"));
  affect.onEvent(event("control", { cmd: "pause" }));
  const spy = mock.method(affect.mood, "tick");
  affect.publish();
  assert.equal(spy.mock.callCount(), 1);
});

test("forget_context applies the pending decay first, so the mood lands exactly on baseline", () => { // @spec AFF-IN-007
  const clock = fakeClock();
  {
    const bus = new FakeBus();
    const real = testConfig({ brain: { affect: { half_life_ms: 45_000 } } }); // baseline_valence 0.15, baseline_arousal 0.1
    const mod = new Module<AppraiseInput, AppraiseOutput>("a", ModuleSchema.parse({}), real.llm, { rules: appraiseRules }, silentLog);
    const affect = new Affect({ cfg: real, bus, appraiser: mod, log: silentLog, now: clock.now });
    for (let i = 0; i < 5; i++) affect.onEvent(chat(`LOL POGGERS!!! ${i}`, { userId: `u${i}` }));
    assert.ok(affect.mood.valence > 0.5 && affect.mood.arousal > 0.5, "a real peak");
    clock.tick(2_000); // the default publish interval: decay accrued since the last touch
    affect.onEvent(event("control", { cmd: "forget_context" }));
    assert.ok(near(affect.mood.valence, 0.15), `valence ${affect.mood.valence}`);
    assert.ok(near(affect.mood.arousal, 0.1), `arousal ${affect.mood.arousal}`);
    assert.equal(affect.mood.cause, "reset");
    clock.tick(100_000);
    affect.publish();
    assert.ok(near(bus.of("affect.state")[0]!.valence, 0.15));
  }
});

test("brain.affect.baseline_arousal is the initial arousal, the decay target and the reset value", () => { // @spec AFF-MOOD-006
  const clock = fakeClock();
  {
    const bus = new FakeBus();
    const c = testConfig({ brain: { affect: { baseline_arousal: 0.4, half_life_ms: 10_000 } } });
    const mod = new Module<AppraiseInput, AppraiseOutput>("a", ModuleSchema.parse({}), c.llm, { rules: appraiseRules }, silentLog);
    const affect = new Affect({ cfg: c, bus, appraiser: mod, log: silentLog, now: clock.now });
    assert.equal(affect.mood.arousal, 0.4, "initial");

    affect.onEvent(event("vision.summary", { text: "x", changed: true }));
    assert.ok(near(affect.mood.arousal, 0.48));
    clock.tick(10_000 * 40); // forty half-lives
    affect.mood.tick();
    assert.ok(Math.abs(affect.mood.arousal - 0.4) < 1e-6, "decays to the configured resting arousal, not 0.1");

    affect.onEvent(event("vision.summary", { text: "x", changed: true }));
    affect.onEvent(event("control", { cmd: "forget_context" }));
    assert.ok(near(affect.mood.arousal, 0.4), "reset value");
  }
});

test("forget_context discards queued appraisals and the one in flight; pause drops queued jobs unapplied", async () => { // @spec AFF-HOOK-008
  // reset
  const r = setup("http");
  r.affect.onEvent(chat("what a great play"));   // in flight
  r.affect.onEvent(chat("love this game", { userId: "u2" }));      // queued
  r.affect.onEvent(chat("another great one", { userId: "u3" }));   // queued
  assert.equal(r.seen.length, 1);
  r.affect.onEvent(event("control", { cmd: "forget_context" }));
  r.next();                                       // the in-flight appraisal finishes after the reset
  await r.affect.settled();
  assert.equal(r.seen.length, 1, "queued jobs never reached the appraiser");
  assert.ok(near(r.affect.mood.valence, 0), "no appraisal changed the mood after the reset");

  // pause
  const p = setup("http");
  p.affect.onEvent(chat("what a great play"));
  p.affect.onEvent(chat("love this game", { userId: "u2" }));
  p.affect.onEvent(event("control", { cmd: "pause" }));
  p.next();
  await p.affect.settled();
  assert.equal(p.seen.length, 1, "the queued job was dropped, not run");
  assert.equal(p.affect.mood.valence, 0, "nothing applied while paused");
  p.affect.onEvent(event("control", { cmd: "resume" }));
  assert.equal(p.affect.mood.valence, 0, "and nothing from before the pause lands after resume");

  // new lines after the reset or resume are appraised normally
  p.affect.onEvent(chat("fresh great line", { userId: "u9" }));
  p.next();
  await p.affect.settled();
  assert.ok(near(p.affect.mood.valence, 0.1));
});

test("a failed affect.state publish is logged and affect keeps running", async () => { // @spec AFF-PUB-004
  const bus = new FakeBus();
  const rec = recordingLog();
  const mod = new Module<AppraiseInput, AppraiseOutput>("a", ModuleSchema.parse({}), cfg.llm, { rules: appraiseRules }, silentLog);
  const affect = new Affect({ cfg, bus, appraiser: mod, log: rec.log });
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  try {
    bus.fail = (t) => t === "affect.state";
    assert.doesNotThrow(() => affect.publish());
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(unhandled, []);
    assert.equal(rec.lines.filter((l) => l.level !== "debug").length, 1);
    assert.match(String(rec.lines.find((l) => l.level !== "debug")!.msg), /affect\.state/);

    bus.fail = undefined;
    affect.onEvent(chat("lol nice"));
    affect.publish();
    await new Promise((r) => setImmediate(r));
    assert.equal(bus.of("affect.state").length, 1, "the next publish went through");
  } finally { process.off("unhandledRejection", onUnhandled); }
});

// ---- bounded intake and counting chat once (AFF-IN-002, 003, 008..016)

const WINDOW = 30_000; // brain.affect.count_window_ms default
/** An Affect on the rules appraiser and a fake clock shared by the mood and the counter. */
function counted(over: Record<string, unknown> = {}) {
  const c = testConfig({ brain: { affect: { baseline_valence: 0, half_life_ms: 10_000_000, ...over } } });
  const clock = fakeClock();
  const mod = new Module<AppraiseInput, AppraiseOutput>("a", ModuleSchema.parse({}), c.llm, { rules: appraiseRules }, silentLog);
  return { affect: new Affect({ cfg: c, bus: new FakeBus(), appraiser: mod, log: silentLog, now: clock.now }), clock };
}
/** A distinct viewer: its own platform user id and name, so only the text or an explicit repeat can collide. */
const from = (n: string, text: string, extra: Record<string, unknown> = {}) => chat(text, { user: `viewer${n}`, userId: `id${n}`, ...extra });

test("chat text and name are bounded before use: cause, queue and appraiser see the bounded values", () => { // @spec AFF-IN-008
  const { affect, seen, next } = setup("http");
  const text = "a great play ".repeat(60);
  const user = "n".repeat(60);
  affect.onEvent(chat(text, { user, userId: "u1" }));
  assert.equal(seen[0]!.text, boundText(text, 500));
  assert.equal(seen[0]!.who, boundText(user, 40));
  next();
  const empty = setup();
  empty.affect.onEvent(chat("lol nice", { user: "", userId: "u2" }));
  assert.equal(empty.affect.mood.cause, "chat: unknown", "a name that bounds to nothing is `unknown`");
  const named = setup();
  named.affect.onEvent(chat("lol nice", { user, userId: "u3" }));
  assert.equal(named.affect.mood.cause, `chat: ${boundText(user, 40)}`);
});

test("speech text and speaker are bounded before use", () => { // @spec AFF-IN-009
  const { affect, seen, next } = setup("http");
  const text = "that was a great play ".repeat(80);
  const speaker = "s".repeat(60);
  affect.onEvent(event("speech.heard", { speaker, text, durationMs: 900 }));
  assert.equal(seen[0]!.text, boundText(text, 1000));
  assert.equal(seen[0]!.who, boundText(speaker, 40));
  next();
  const empty = setup();
  empty.affect.onEvent(event("speech.heard", { speaker: "", text: "lol nice", durationMs: 900 }));
  assert.equal(empty.affect.mood.cause, "voice: unknown");
  const named = setup();
  named.affect.onEvent(event("speech.heard", { speaker, text: "lol nice", durationMs: 900 }));
  assert.equal(named.affect.mood.cause, `voice: ${boundText(speaker, 40)}`);
});

test("an admitted chat line is appraised as chat with its mention flag and cause chat: <user>; speech as speech with no mention boost", () => { // @spec AFF-IN-002, AFF-IN-003
  const mention = setup("http");
  mention.affect.onEvent(chat("hey Coco what a play", { mentionsCohost: true }));
  assert.equal(mention.seen[0]!.source, "chat");
  assert.equal(mention.seen[0]!.mention, true);
  mention.next();
  const speech = setup("http");
  speech.affect.onEvent(event("speech.heard", { speaker: "Chris", text: "hey Coco what a play", durationMs: 900 }));
  assert.equal(speech.seen[0]!.source, "speech");
  assert.equal(speech.seen[0]!.mention, false);
  speech.next();
  const { affect } = counted();
  affect.onEvent(chat("lol nice", { user: "Zed", userId: "z" }));
  assert.equal(affect.mood.cause, "chat: Zed");
  affect.onEvent(event("speech.heard", { speaker: "Chris", text: "lol nice", durationMs: 900 }));
  assert.equal(affect.mood.cause, "voice: Chris");
});

test("one viewer's burst moves the mood once per window; the window is brain.affect.count_window_ms", () => { // @spec AFF-IN-010, AFF-IN-012, AFF-IN-013
  const { affect, clock } = counted();
  affect.onEvent(chat("lol nice", { userId: "u1" }));
  const a1 = affect.mood.arousal;
  assert.ok(a1 > 0.1, "the first line moved the mood");
  for (let i = 0; i < 5; i++) affect.onEvent(chat(`distinct line number ${i} lol`, { userId: "u1" }));
  assert.equal(affect.mood.arousal, a1, "the burst moved nothing more");
  clock.tick(WINDOW - 1);
  affect.onEvent(chat("another one", { userId: "u1" }));
  assert.ok(affect.mood.arousal <= a1, "still inside the window, still refused (decay only lowers it)");
  const before = affect.mood.arousal;
  clock.tick(1);
  affect.onEvent(chat("window is over", { userId: "u1" }));
  assert.ok(affect.mood.arousal > before + 0.02, "the window ended: the viewer counts again");

  const short = counted({ count_window_ms: 1000 });
  short.affect.onEvent(chat("lol nice", { userId: "u1" }));
  const s1 = short.affect.mood.arousal;
  short.clock.tick(1000);
  short.affect.onEvent(chat("lol nice again", { userId: "u1" }));
  assert.ok(short.affect.mood.arousal > s1 + 0.02, "the counter's window is the configured one, not a default");
});

test("a refused line does not extend the window: a viewer who keeps posting moves the mood once per window", () => { // @spec AFF-IN-013
  const { affect, clock } = counted();
  affect.onEvent(chat("lol nice", { userId: "u1" }));
  clock.tick(20_000);
  const mid = affect.mood.arousal;
  affect.onEvent(chat("still here", { userId: "u1" })); // refused at +20 s
  assert.equal(affect.mood.arousal, mid);
  clock.tick(10_000); // +30 s from the admitted line, +10 s from the refused one
  const before = affect.mood.arousal;
  affect.onEvent(chat("and again", { userId: "u1" }));
  assert.ok(affect.mood.arousal > before + 0.02, "counted once the first line's window ended");
});

test("one pasted text from many viewers moves the mood once per window", () => { // @spec AFF-IN-010, AFF-IN-012
  const { affect, clock } = counted();
  affect.onEvent(from("1", "SPAM THIS PASTA lol"));
  const a1 = affect.mood.arousal;
  for (let i = 2; i < 12; i++) affect.onEvent(from(String(i), "  spam this PASTA   lol "));
  assert.equal(affect.mood.arousal, a1);
  clock.tick(WINDOW);
  const before = affect.mood.arousal;
  affect.onEvent(from("20", "spam this pasta lol"));
  assert.ok(affect.mood.arousal > before + 0.02, "the text counts again after the window");
});

test("a refused line is not appraised, gets no subscriber nudge, leaves the cause alone and records nothing", () => { // @spec AFF-IN-012, AFF-IN-013
  const { affect } = counted();
  affect.onEvent(chat("lol nice", { user: "bob", userId: "u1" }));
  const v = affect.mood.valence, a = affect.mood.arousal;
  affect.onEvent(chat("ok", { user: "bob", userId: "u1", isSub: true }));
  assert.equal(affect.mood.valence, v);
  assert.equal(affect.mood.arousal, a);
  assert.equal(affect.mood.cause, "chat: bob", "neither the line's cause nor `sub: bob`");
  affect.onEvent(chat("lol nice", { user: "amy", userId: "u2", isSub: true }));
  assert.equal(affect.mood.arousal, a, "the same text from another viewer is refused too, with no sub nudge");
  assert.equal(affect.mood.cause, "chat: bob");
});

test("a subscriber's admitted line still gets the subscriber nudge", () => { // @spec AFF-IN-002, AFF-IN-012
  const { affect } = counted();
  affect.onEvent(chat("zzzz", { user: "bob", userId: "u1", isSub: true }));
  assert.equal(affect.mood.cause, "sub: bob");
});

test("a mention is counted like any line: a repeat inside the window moves the mood once", () => { // @spec AFF-IN-014
  const { affect } = counted();
  affect.onEvent(chat("hey Coco", { userId: "u1", mentionsCohost: true }));
  const a1 = affect.mood.arousal;
  assert.ok(a1 > 0.3, "the mention moved arousal");
  affect.onEvent(chat("hey Coco again", { userId: "u1", mentionsCohost: true }));
  assert.equal(affect.mood.arousal, a1, "same viewer");
  affect.onEvent(from("2", "hey Coco", { mentionsCohost: true }));
  assert.equal(affect.mood.arousal, a1, "same text");
});

test("a mention in the queue path (llm/http) is refused like any line and never queued", async () => { // @spec AFF-IN-012, AFF-IN-014
  const { affect, seen, next } = setup("http", fakeClock().now);
  affect.onEvent(chat("hey Coco what a play", { userId: "u1", mentionsCohost: true }));
  affect.onEvent(chat("hey Coco and another", { userId: "u1", mentionsCohost: true }));
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); // give a wrongly queued job every chance to start
  assert.equal(seen.length, 1, "the refused mention was never queued");
  next();
  await affect.settled();
});

test("speech never passes through the chat counter", () => { // @spec AFF-IN-015
  const { affect } = counted();
  const say = () => affect.onEvent(event("speech.heard", { speaker: "Chris", text: "this is great", durationMs: 900 }));
  say();
  const a1 = affect.mood.arousal;
  say();
  assert.ok(affect.mood.arousal > a1 + 0.1, "the same speaker and the same text move the mood each time");
  const before = affect.mood.arousal;
  affect.onEvent(chat("this is great", { user: "Chris", userId: "c" }));
  assert.ok(affect.mood.arousal > before + 0.02, "speech recorded nothing: a chat line with the same text counts");
});

test("forget_context replaces the counter: the next line from a counted viewer is admitted", () => { // @spec AFF-IN-016
  const { affect } = counted();
  affect.onEvent(chat("lol nice", { userId: "u1" }));
  const a1 = affect.mood.arousal;
  affect.onEvent(chat("lol nice", { userId: "u1" }));
  assert.equal(affect.mood.arousal, a1, "counted before the reset");
  affect.onEvent(event("control", { cmd: "forget_context" }));
  assert.equal(affect.mood.cause, "reset");
  affect.onEvent(chat("lol nice", { userId: "u1" }));
  assert.equal(affect.mood.cause, "chat: bob", "the same viewer and text count again with no clock movement");
  assert.ok(affect.mood.arousal > 0.12, "and move the mood from baseline");
});
