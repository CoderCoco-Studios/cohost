import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ModuleSchema } from "@cohost/config";
import { Module } from "@cohost/modules";
import { FakeBus, event, recordingLog, silentLog, testConfig } from "@cohost/testing";
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
  affect.onEvent(chat("what a great play"));
  affect.onEvent(chat("love this game"));
  assert.equal(seen.length, 1, "one at a time");
  assert.equal(affect.mood.valence, 0, "nothing applied yet");
  next();
  await new Promise((r) => setImmediate(r));
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
  affect.onEvent(chat("hi", { mentionsCohost: true }));
  assert.equal(seen.length, 1);
  next();
  await affect.settled();
});

test("llm/http kind: when appraisal falls behind, the oldest waiting lines are dropped", async () => { // @spec AFF-HOOK-006
  const { affect, seen, next } = setup("http");
  for (let i = 0; i < 12; i++) affect.onEvent(chat(`line number ${i}`));
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
  affect.onEvent(chat("lol clutch"));
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
    for (let i = 0; i < 5; i++) affect.onEvent(chat("LOL POGGERS!!!"));
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
  r.affect.onEvent(chat("love this game"));      // queued
  r.affect.onEvent(chat("another great one"));   // queued
  assert.equal(r.seen.length, 1);
  r.affect.onEvent(event("control", { cmd: "forget_context" }));
  r.next();                                       // the in-flight appraisal finishes after the reset
  await r.affect.settled();
  assert.equal(r.seen.length, 1, "queued jobs never reached the appraiser");
  assert.ok(near(r.affect.mood.valence, 0), "no appraisal changed the mood after the reset");

  // pause
  const p = setup("http");
  p.affect.onEvent(chat("what a great play"));
  p.affect.onEvent(chat("love this game"));
  p.affect.onEvent(event("control", { cmd: "pause" }));
  p.next();
  await p.affect.settled();
  assert.equal(p.seen.length, 1, "the queued job was dropped, not run");
  assert.equal(p.affect.mood.valence, 0, "nothing applied while paused");
  p.affect.onEvent(event("control", { cmd: "resume" }));
  assert.equal(p.affect.mood.valence, 0, "and nothing from before the pause lands after resume");

  // new lines after the reset or resume are appraised normally
  p.affect.onEvent(chat("fresh great line"));
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
