import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { ModuleSchema } from "@cohost/config";
import { Module } from "@cohost/modules";
import { FakeBus, event, silentLog, testConfig } from "@cohost/testing";
import { Affect } from "../src/affect.js";
import { appraiseRules, type AppraiseInput, type AppraiseOutput } from "../src/appraise.js";
import { label } from "../src/mood.js";

const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
const chat = (text: string, extra: Record<string, unknown> = {}) =>
  event("chat.message", { platform: "twitch", user: "bob", text, isMod: false, isSub: false, mentionsCohost: false, ...extra });

/** An Affect on a fake monotonic clock; `kind: "http"` talks to a stubbed `fetch`, the real hook path. */
function setup(affectCfg: Record<string, unknown> = {}, kind: "rules" | "http" = "rules") {
  let clock = 1_000_000;
  const cfg = testConfig({ brain: { affect: { baseline_valence: 0, half_life_ms: 10_000_000, ...affectCfg } } });
  const bus = new FakeBus();
  const mod = new Module<AppraiseInput, AppraiseOutput>(
    "a", ModuleSchema.parse(kind === "http" ? { kind, url: "http://appraiser.test/x" } : {}), cfg.llm,
    {
      rules: appraiseRules,
      http: { validate: (raw) => {
        const r = raw as Partial<AppraiseOutput>;
        return typeof r.valence_delta === "number" && typeof r.arousal_delta === "number" ? { valence_delta: r.valence_delta, arousal_delta: r.arousal_delta } : undefined;
      } },
    },
    silentLog,
  );
  const sent: AppraiseInput[] = [];
  const details: (string | undefined)[] = [];
  let respond: () => Response = () => new Response(JSON.stringify({ valence_delta: 0.1, arousal_delta: 0 }));
  const fetchStub = mock.method(globalThis, "fetch", async (_url: unknown, init?: { body?: unknown }) => {
    sent.push(JSON.parse(String(init?.body)) as AppraiseInput);
    return respond();
  });
  const affect = new Affect({ cfg, bus, appraiser: mod, log: silentLog, now: () => clock, heartbeat: { setDetail: (d) => details.push(d) } });
  return {
    affect, bus, sent, details, cfg,
    tick: (ms: number) => { clock += ms; },
    failHttp: () => { respond = () => new Response("nope", { status: 500 }); },
    done: () => fetchStub.mock.restore(),
  };
}

// ---- nudge sizes, republish and short-line cutoff are settings

test("a sub's line nudges valence and arousal by the configured sizes, with the sub cause", () => { // @spec AFF-IN-004
  const d = setup({ nudge_sub_valence: 0.2, nudge_sub_arousal: 0.3 });
  try {
    d.affect.onEvent(chat("zzzz", { isSub: true })); // no word-list hit: the chat appraisal adds arousal only
    assert.ok(near(d.affect.mood.valence, 0.2), `valence ${d.affect.mood.valence}`);
    assert.ok(near(d.affect.mood.arousal, 0.1 + 0.03 + 0.3), `arousal ${d.affect.mood.arousal}`);
    assert.equal(d.affect.mood.cause, "sub: bob");
  } finally { d.done(); }
  const dflt = setup();
  try {
    dflt.affect.onEvent(chat("zzzz", { isSub: true }));
    assert.ok(near(dflt.affect.mood.valence, 0.05));
    assert.ok(near(dflt.affect.mood.arousal, 0.1 + 0.03 + 0.05));
  } finally { dflt.done(); }
});

test("a changed screen nudges arousal by the configured size; an unchanged one nothing", () => { // @spec AFF-IN-005
  const d = setup({ nudge_screen_arousal: 0.25 });
  try {
    d.affect.onEvent(event("vision.summary", { text: "x", changed: false }));
    assert.ok(near(d.affect.mood.arousal, 0.1));
    d.affect.onEvent(event("vision.summary", { text: "x", changed: true }));
    assert.ok(near(d.affect.mood.arousal, 0.35));
    assert.equal(d.affect.mood.valence, 0);
  } finally { d.done(); }
});

test("the co-host's own line nudges valence by the signed configured size and arousal by the configured size", () => { // @spec AFF-IN-006
  const d = setup({ nudge_said_valence: 0.1, nudge_said_arousal: 0.2 });
  try {
    const say = (emotion: string) => d.affect.onEvent(event("brain.say", { id: emotion, text: "t", emotion: emotion as never }));
    for (const [emotion, dv] of [["happy", 0.1], ["laugh", 0.1], ["smug", 0.1], ["sad", -0.1], ["angry", -0.1], ["neutral", 0], ["think", 0]] as const) {
      const before = { v: d.affect.mood.valence, a: d.affect.mood.arousal };
      say(emotion);
      assert.ok(near(d.affect.mood.valence, before.v + dv), `${emotion}: valence`);
      assert.ok(near(d.affect.mood.arousal, Math.min(1, before.a + 0.2)), `${emotion}: arousal`);
      assert.equal(d.affect.mood.cause, `said: ${emotion}`);
    }
  } finally { d.done(); }
});

test("an unchanged mood is republished after brain.affect.republish_ms, not before", () => { // @spec AFF-PUB-002, AFF-PUB-003
  const d = setup({ republish_ms: 5_000 });
  try {
    d.affect.publish();
    d.tick(4_999);
    d.affect.publish();
    assert.equal(d.bus.of("affect.state").length, 1);
    d.tick(1);
    d.affect.publish();
    assert.equal(d.bus.of("affect.state").length, 2);
  } finally { d.done(); }
});

test("with an llm/http appraiser a line shorter than short_line_chars (trimmed) is appraised inline, a mention never", async () => { // @spec AFF-HOOK-007
  const d = setup({ short_line_chars: 4 }, "http");
  try {
    d.affect.onEvent(chat("abc")); // 3 characters: inline
    d.affect.onEvent(chat("  ab   ")); // trims to 2: inline
    assert.equal(d.sent.length, 0);
    d.affect.onEvent(chat("abcd")); // exactly the cutoff: the module
    await d.affect.settled();
    assert.equal(d.sent.length, 1);
    assert.equal(d.sent[0]!.text, "abcd");
  } finally { d.done(); }
  const none = setup({ short_line_chars: 0 }, "http");
  try {
    none.affect.onEvent(chat("a"));
    await none.affect.settled();
    assert.equal(none.sent.length, 1, "cutoff 0: nothing is too short");
  } finally { none.done(); }
});

test("the http appraiser failing falls back to the rules appraisal of the line", async () => { // @spec AFF-HOOK-003
  const d = setup({}, "http");
  try {
    d.failHttp();
    d.affect.onEvent(chat("lol that was clutch"));
    await d.affect.settled();
    const rules = appraiseRules({ source: "chat", who: "bob", text: "lol that was clutch", mention: false, valence: 0, arousal: 0.1 });
    assert.ok(near(d.affect.mood.valence, rules.valence_delta));
  } finally { d.done(); }
});

// ---- exact appraisal sizes and label boundaries

const base: AppraiseInput = { source: "chat", who: "w", text: "zzzz", mention: false, valence: 0, arousal: 0 };

test("rules appraisal: base arousal 0.15 for speech, 0.03 for chat, +0.2 for a mention", () => { // @spec AFF-APPR-001
  assert.deepEqual(appraiseRules(base), { valence_delta: 0, arousal_delta: 0.03 });
  assert.deepEqual(appraiseRules({ ...base, source: "speech" }), { valence_delta: 0, arousal_delta: 0.15 });
  assert.ok(near(appraiseRules({ ...base, mention: true }).arousal_delta, 0.23));
  assert.ok(near(appraiseRules({ ...base, source: "speech", mention: true }).arousal_delta, 0.35));
});

test("rules appraisal: positive +0.12/+0.05, negative -0.15/+0.08, both net", () => { // @spec AFF-APPR-002
  const pos = appraiseRules({ ...base, text: "lol" });
  assert.ok(near(pos.valence_delta, 0.12) && near(pos.arousal_delta, 0.08));
  const neg = appraiseRules({ ...base, text: "trash" });
  assert.ok(near(neg.valence_delta, -0.15) && near(neg.arousal_delta, 0.11));
  const both = appraiseRules({ ...base, text: "lol trash" });
  assert.ok(near(both.valence_delta, -0.03) && near(both.arousal_delta, 0.16));
});

test("rules appraisal: !! or five capitals +0.05 arousal, a question mark +0.03", () => { // @spec AFF-APPR-003
  assert.ok(near(appraiseRules({ ...base, text: "zzzz!!" }).arousal_delta, 0.08));
  assert.ok(near(appraiseRules({ ...base, text: "zzzz!" }).arousal_delta, 0.03), "one ! is not enough");
  assert.ok(near(appraiseRules({ ...base, text: "ABCDE" }).arousal_delta, 0.08));
  assert.ok(near(appraiseRules({ ...base, text: "ABCD" }).arousal_delta, 0.03), "four capitals are not enough");
  assert.ok(near(appraiseRules({ ...base, text: "zzzz?" }).arousal_delta, 0.06));
  assert.ok(near(appraiseRules({ ...base, text: "ABCDE!!?" }).arousal_delta, 0.03 + 0.05 + 0.03), "a !! run and capitals count once");
});

test("label boundaries: the thresholds themselves fall on the lower side", () => { // @spec AFF-MOOD-004
  // arousal above 0.6
  assert.equal(label(0.31, 0.61), "laugh");
  assert.equal(label(0.3, 0.61), "surprised");
  assert.equal(label(-0.3, 0.61), "surprised");
  assert.equal(label(-0.31, 0.61), "angry");
  // arousal exactly 0.6 is the middle band
  assert.equal(label(0.21, 0.6), "happy");
  assert.equal(label(0.2, 0.6), "think");
  assert.equal(label(-0.2, 0.6), "think");
  assert.equal(label(-0.21, 0.6), "confused");
  // arousal exactly 0.3 is the low band
  assert.equal(label(0.36, 0.3), "smug");
  assert.equal(label(0.35, 0.3), "neutral");
  assert.equal(label(-0.3, 0.3), "neutral");
  assert.equal(label(-0.31, 0.3), "sad");
});

// ---- control and restart

test("while paused affect keeps decaying and publishing affect.state", () => { // @spec AFF-CTRL-003
  let clock = 1_000_000;
  const cfg = testConfig({ brain: { affect: { baseline_valence: 0, half_life_ms: 10_000 } } });
  const bus = new FakeBus();
  const mod = new Module<AppraiseInput, AppraiseOutput>("a", ModuleSchema.parse({}), cfg.llm, { rules: appraiseRules }, silentLog);
  const affect = new Affect({ cfg, bus, appraiser: mod, log: silentLog, now: () => clock });
  affect.onEvent(chat("lol clutch"));
  affect.publish();
  const peak = bus.of("affect.state")[0]!.valence;
  affect.onEvent(event("control", { cmd: "pause" }));
  clock += 10_000; // one half-life
  affect.publish();
  const [, after] = bus.of("affect.state");
  assert.ok(after, "published while paused");
  assert.ok(near(after.valence, Math.round((peak / 2) * 1000) / 1000) || Math.abs(after.valence - peak / 2) < 0.002, `valence ${after.valence} halved from ${peak}`);
});

test("a restarted affect starts at the baseline mood and unpaused", () => { // @spec AFF-CTRL-005
  const first = setup({ baseline_valence: 0.15 });
  const second = setup({ baseline_valence: 0.15 });
  try {
    for (let i = 0; i < 5; i++) first.affect.onEvent(chat("LOL POGGERS!!!"));
    first.affect.onEvent(event("control", { cmd: "pause" }));
    assert.ok(first.affect.mood.valence > 0.5);
    // the restart is a new instance: nothing carries over
    assert.ok(near(second.affect.mood.valence, 0.15));
    assert.ok(near(second.affect.mood.arousal, 0.1));
    second.affect.onEvent(chat("lol clutch"));
    assert.ok(second.affect.mood.valence > 0.15, "not paused: events nudge the mood");
  } finally { first.done(); second.done(); }
});

test("pause is reported in the heartbeat detail and cleared by resume", () => { // @spec AFF-HEALTH-004
  const d = setup();
  try {
    d.affect.onEvent(event("control", { cmd: "pause", target: "cortex" }));
    assert.deepEqual(d.details, []);
    d.affect.onEvent(event("control", { cmd: "pause" }));
    d.affect.onEvent(event("control", { cmd: "resume" }));
    assert.deepEqual(d.details, ["paused", undefined]);
  } finally { d.done(); }
});
