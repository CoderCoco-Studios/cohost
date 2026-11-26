import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { ModuleSchema } from "@cohost/config";
import { Module } from "@cohost/modules";
import { FakeBus, event, silentLog, testConfig } from "@cohost/testing";
import { Salience } from "../src/salience.js";
import { scoreRules, type ScoreInput, type ScoreOutput } from "../src/scoring.js";

// Interjection, salience's half (SAL-INTJ-*): at the retraction of a held provisional focus salience may ask cortex to speak the
// prepared reply (an interjected confirm), learns from `brain.say` / `brain.status` whether it was spoken, and decides what the
// person's final does. The clock is a fake `now`; the unresolved-limit timer is node's mocked setTimeout, advanced with the clock.
// The injectable random source is `SalienceDeps.random` (its name is open in the LLD; the issue's edge audit records this choice).

const DIED = { match: "you died", say: ["Oof."], emotion: "surprised", gesture: "facepalm", cooldown_ms: 0 };
const EARLY = "look at this one"; // four words: meets interject_min_words

interface Opts { t0?: number; draw?: number }

function setup(salience: Record<string, unknown> = {}, opts: Opts = {}) {
  const cfg = testConfig({ brain: { salience: { cooldown_ms: 0, idle_chatter_ms: 0, interject: true, ...salience } } });
  const bus = new FakeBus();
  let t = opts.t0 ?? 1_000_000;
  const draw = opts.draw ?? 0;
  let draws = 0;
  const scorer = new Module<ScoreInput, ScoreOutput>("s", ModuleSchema.parse({}), cfg.llm, { rules: (i) => scoreRules(i, true) }, silentLog);
  // `random` is not on SalienceDeps yet: a variable, not an object literal, so only the missing behavior fails.
  const deps = { cfg, bus, scorer, log: silentLog, now: () => t, random: () => { draws++; return draw; } };
  const s = new Salience(deps);
  const advance = (ms: number) => {
    t += ms;
    try { mock.timers.tick(ms); } catch { /* setTimeout is mocked only by the tests that need the unresolved-limit timer */ }
  };
  return { s, bus, cfg, advance, draws: () => draws };
}
type Env = ReturnType<typeof setup>;

const early = (text: string, extra: Record<string, unknown> = {}) =>
  event("speech.early", { speaker: "Chris", source: "discord", text, utteranceId: "u1", seq: 0, sttMs: 120, ...extra });
const heard = (text: string, extra: Record<string, unknown> = {}) =>
  event("speech.heard", { speaker: "Chris", source: "discord", text, durationMs: 900, utteranceId: "u1", earlySeq: 2, ...extra });
const retracted = (seq = 0, utteranceId = "u1") => event("speech.retracted", { speaker: "Chris", source: "discord", utteranceId, seq });
const chat = (text: string, extra: Record<string, unknown> = {}) =>
  event("chat.message", { platform: "twitch", user: "bob", text, isMod: false, isSub: false, mentionsCohost: false, ...extra });
const say = (id = "L1", extra: Record<string, unknown> = {}) =>
  event("brain.say", { id, text: "I know that one", emotion: "happy", reason: "engaged", interjected: true, ...extra });
const status = (state: "idle" | "thinking" | "speaking" | "muted") => event("brain.status", { state });
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
const focuses = (e: Env) => e.bus.of("attention.focus");
const resolves = (e: Env) => e.bus.of("attention.resolve");
const stops = (e: Env) => e.bus.of("voice.stop" as never) as unknown as { reason: string; ids?: string[] }[];
const says = (e: Env) => e.bus.of("brain.say");
const confirms = (e: Env) => resolves(e).filter((r) => r.outcome === "confirm");
const withdraws = (e: Env) => resolves(e).filter((r) => r.outcome === "withdraw");

/** Early pass, then the retraction: leaves the interjection request pending (or the withdraw, when a gate fails). */
async function asked(e: Env, text = EARLY, utteranceId = "u1", seq = 0, extra: Record<string, unknown> = {}): Promise<void> {
  await e.s.onEvent(early(text, { utteranceId, seq, ...extra }));
  await flush();
  await e.s.onEvent(retracted(seq, utteranceId));
  await flush();
}
/** An interjection that cortex spoke: the request, then its `brain.say` with the given line id. */
async function spoken(e: Env, over: { id?: string; utteranceId?: string; seq?: number; text?: string } = {}): Promise<void> {
  const before = confirms(e).length;
  await asked(e, over.text ?? EARLY, over.utteranceId ?? "u1", over.seq ?? 0);
  assert.equal(confirms(e).length, before + 1, "precondition: an interjection was requested");
  await e.s.onEvent(say(over.id ?? "L1"));
  await flush();
}
type Publish = (type: string, data: unknown) => Promise<string>;
/**
 * Makes the bus reject the publishes `match` selects (only the first with `once`), after `gate` opens when given. Returns the types
 * it rejected. A rejected publish leaves the bus as a failed one does: nothing is recorded.
 */
function refuse(e: Env, match: (type: string, data: unknown) => boolean, opts: { once?: boolean; gate?: Promise<void> } = {}): string[] {
  const bus = e.bus as unknown as { publish: Publish };
  const real = bus.publish.bind(e.bus) as Publish;
  const refused: string[] = [];
  bus.publish = async (type, data) => {
    if (match(type, data) && !(opts.once && refused.length > 0)) {
      refused.push(type);
      if (opts.gate) await opts.gate;
      throw new Error(`publish ${type} refused`);
    }
    return real(type, data);
  };
  return refused;
}
const lastSpeech = (e: Env) => [...e.s.ctx.all()].reverse().find((x) => x.kind === "speech" && !x.unfinished);

// ---- Asking at the retraction -------------------------------------------------------------------------------------------

test("interject: an eligible retraction publishes an interjected confirm with the provisional timing, draws once, and holds the request pending", async () => { // @spec SAL-INTJ-001, SAL-INTJ-004, SAL-INTJ-006
  const e = setup({}, { draw: 0.1 });
  await asked(e, EARLY, "u1", 3, { timing: { audioEndedAt: 5555, closedAt: 5000 } });
  assert.deepEqual(resolves(e), [{
    utteranceId: "u1", seq: 3, outcome: "confirm", interjected: true, reason: "engaged", score: 0.9,
    focus: { kind: "speech", who: "Chris", text: EARLY, source: "discord", mention: false },
    timing: { audioEndedAt: 5555, closedAt: 5000 },
  }]);
  assert.equal(e.draws(), 1, "one random draw for the retraction");
  // Pending: the state is thinking, so nothing new is decided and nothing is withdrawn.
  await e.s.onEvent(chat("hey Coco?", { mentionsCohost: true, user: "carol" }));
  await e.s.tick();
  assert.equal(focuses(e).length, 1, "thinking while the request is pending");
  assert.equal(resolves(e).length, 1);
});

test("interject: with interject false the retraction withdraws as resumed and no request is made", async () => { // @spec SAL-INTJ-001, SAL-INTJ-005
  const e = setup({ interject: false }, { draw: 0 });
  await asked(e);
  assert.deepEqual(resolves(e), [{ utteranceId: "u1", seq: 0, outcome: "withdraw", reason: "resumed" }]);
  assert.equal(e.draws(), 0, "no draw when interject is off");
});

test("interject: a retraction of another seq or utterance is ignored: no request, no withdraw, no draw", async () => { // @spec SAL-INTJ-001
  const e = setup({}, { draw: 0 });
  await e.s.onEvent(early(EARLY, { seq: 1 }));
  await flush();
  await e.s.onEvent(retracted(0));
  await e.s.onEvent(retracted(1, "other"));
  await flush();
  assert.equal(resolves(e).length, 0);
  assert.equal(e.draws(), 0);
});

test("interject: a paused or muted salience asks for nothing: the focus is withdrawn by the pause or mute", async () => { // @spec SAL-INTJ-001, SAL-INTJ-005
  for (const cmd of ["pause", "mute"] as const) {
    const e = setup({}, { draw: 0 });
    await e.s.onEvent(early(EARLY));
    await flush();
    await e.s.onEvent(event("control", { cmd }));
    await flush();
    await e.s.onEvent(retracted(0));
    await flush();
    assert.equal(confirms(e).length, 0, `${cmd}: no interjection requested`);
    assert.equal(withdraws(e).length, 1, `${cmd}: withdrawn once`);
  }
});

test("interject: an early text under interject_min_words, counted as barge-in counts, is withdrawn", async () => { // @spec SAL-INTJ-002, SAL-INTJ-005
  for (const text of ["look at this", "look at this -- ..."]) { // the second has five tokens, only three with a letter or a number
    const e = setup({}, { draw: 0 });
    await asked(e, text);
    assert.equal(confirms(e).length, 0, text);
    assert.equal(e.draws(), 0, `${text}: no draw below the minimum`);
    assert.deepEqual(withdraws(e).map((w) => w.reason), ["resumed"], text);
  }
  const ok = setup({ interject_min_words: 3 }, { draw: 0 });
  await asked(ok, "look at this");
  assert.equal(confirms(ok).length, 1, "control: the same text meets a lower minimum");
});

test("interject: the first interjection is allowed at once, on any clock reading, and later ones wait interject_min_gap_ms from the spoken one", async () => { // @spec SAL-INTJ-003, SAL-INTJ-005
  const e = setup({}, { t0: 1_000, draw: 0 }); // a monotonic clock just after start-up: no spoken interjection yet, so no gap to wait for
  await spoken(e, { utteranceId: "u1" });
  assert.equal(confirms(e).length, 1, "the first request is made with the clock at 1000 ms");
  await e.s.onEvent(status("idle"));
  e.advance(119_999);
  await asked(e, EARLY, "u2");
  assert.equal(confirms(e).length, 1, "119999 ms after the spoken one: withdrawn");
  assert.equal(e.draws(), 1, "refused by the gap before the draw");
  assert.deepEqual(withdraws(e).map((w) => w.reason), ["resumed"]);
  e.advance(1);
  await asked(e, EARLY, "u3");
  assert.equal(confirms(e).length, 2, "exactly 120000 ms after the spoken one: asked");
  assert.equal(confirms(e)[1]!.utteranceId, "u3");
  assert.equal(e.draws(), 2, "one draw for each retraction that met the gate");
});

test("interject: the draw must be strictly below interject_chance", async () => { // @spec SAL-INTJ-004, SAL-INTJ-005
  const at = setup({}, { draw: 0.15 });
  await asked(at);
  assert.equal(at.draws(), 1);
  assert.equal(confirms(at).length, 0, "a draw equal to the chance is not below it");
  assert.deepEqual(withdraws(at).map((w) => w.reason), ["resumed"]);
  const under = setup({}, { draw: 0.1499 });
  await asked(under);
  assert.equal(confirms(under).length, 1);
  const never = setup({ interject_chance: 0 }, { draw: 0 });
  await asked(never);
  assert.equal(confirms(never).length, 0, "chance 0 never asks");
});

// ---- What salience learns -----------------------------------------------------------------------------------------------

test("interject: the request's brain.say records it as spoken: scored events seen, the early text pushed as an unfinished line, the state speaking, the cooldown started", async () => { // @spec SAL-INTJ-007, SAL-INTJ-019, SAL-INTJ-020
  const e = setup({ cooldown_ms: 6000 }, { draw: 0 });
  await e.s.onEvent(chat("is this good?")); // scored by the provisional decision beside the early speech
  await spoken(e);
  assert.equal(e.s.ctx.unseen().length, 0, "the events the provisional decision scored are seen");
  const unfinished = e.s.ctx.all().find((x) => x.kind === "speech" && x.unfinished);
  assert.ok(unfinished && unfinished.kind === "speech", "the early text is in the window as an unfinished line");
  assert.equal(unfinished.text, EARLY);
  assert.equal(unfinished.speaker, "Chris");
  assert.equal(unfinished.seen, true);
  assert.equal(e.s.scheduler.cooling(), true, "the cooldown starts at the brain.say");
  await e.s.onEvent(chat("hey Coco?", { mentionsCohost: true, user: "carol" }));
  await e.s.tick();
  assert.equal(focuses(e).length, 1, "speaking: no new focus");
});

test("interject: a non-thinking status first drops the request: no gap, nothing pushed, nothing marked seen", async () => { // @spec SAL-INTJ-008
  for (const state of ["idle", "muted", "speaking"] as const) {
    const e = setup({}, { draw: 0 });
    await e.s.onEvent(chat("is this good?"));
    await asked(e);
    assert.equal(confirms(e).length, 1);
    await e.s.onEvent(status(state));
    await flush();
    assert.equal(e.s.ctx.all().some((x) => x.kind === "speech"), false, `${state}: nothing pushed into the window`);
    assert.equal(e.s.ctx.unseen().length, 1, `${state}: the scored chat line stays unseen`);
    assert.equal(resolves(e).length, 1, `${state}: the drop publishes nothing`);
    // No gap was charged, so a new interjection is asked for at once.
    await e.s.onEvent(status("idle"));
    await asked(e, EARLY, "u2");
    assert.equal(confirms(e).length, 2, `${state}: no gap charged`);
  }
});

test("interject: a thinking status leaves the request pending, so a later brain.say still records it as spoken", async () => { // @spec SAL-INTJ-006, SAL-INTJ-008
  const e = setup({}, { draw: 0 });
  await asked(e);
  await e.s.onEvent(status("thinking"));
  await e.s.onEvent(say());
  await flush();
  assert.ok(e.s.ctx.all().some((x) => x.kind === "speech" && x.unfinished));
});

test("interject: after a dropped request a later early transcript of the same utterance is an ordinary pass and may ask again", async () => { // @spec SAL-INTJ-016
  const e = setup({}, { draw: 0 });
  await asked(e, EARLY, "u1", 0);
  await e.s.onEvent(status("idle"));
  await asked(e, "look at this one and more", "u1", 1);
  assert.equal(focuses(e).length, 2, "a second provisional focus for seq 1");
  assert.equal(confirms(e).length, 2);
  assert.equal(confirms(e)[1]!.seq, 1);
});

test("interject: at unresolved_limit_ms with no signal the state is idle, no gap is charged and nothing is published", async () => { // @spec SAL-INTJ-018
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const e = setup({ unresolved_limit_ms: 4000 }, { draw: 0 });
    await asked(e);
    e.advance(3999);
    await flush();
    await e.s.onEvent(chat("hey Coco?", { mentionsCohost: true, user: "carol" }));
    await e.s.tick();
    assert.equal(focuses(e).length, 1, "still pending: thinking");
    const published = e.bus.published.length;
    e.advance(1);
    await flush();
    assert.equal(e.bus.published.length, published, "the limit publishes nothing");
    await e.s.tick();
    assert.equal(focuses(e).length, 2, "the state is idle: the chat mention is decided");
    await e.s.onEvent(status("idle"));
    await asked(e, EARLY, "u2");
    assert.equal(confirms(e).length, 2, "no gap charged");
  } finally { mock.timers.reset(); }
});

test("interject: the record keeps the last eight interjections", async () => { // @spec SAL-INTJ-021
  const e = setup({ interject_min_gap_ms: 1 }, { draw: 0 });
  for (let i = 0; i < 9; i++) {
    e.advance(2);
    await spoken(e, { utteranceId: `u${i}`, id: `L${i}` });
    await e.s.onEvent(status("idle"));
  }
  // u8 is among the last eight: its short final is a continuation and decides nothing.
  await e.s.onEvent(heard(EARLY, { utteranceId: "u8" }));
  await flush();
  assert.equal(focuses(e).length, 9, "no decision for the final of a recorded interjection (nine provisional focuses only)");
  // u0 fell out of the ring: its final is an ordinary line.
  await e.s.onEvent(heard(`${EARLY} again`, { utteranceId: "u0" }));
  await flush();
  assert.equal(focuses(e).length, 10, "the evicted interjection's final takes the ordinary path");
  assert.equal(focuses(e)[9]!.provisional, undefined);
});

test("interject: a final that never arrives leaves the unfinished line in the window and nothing else happens", async () => { // @spec SAL-INTJ-014
  const e = setup({}, { draw: 0 });
  await spoken(e);
  const published = e.bus.published.length;
  e.advance(3_600_000);
  await e.s.tick();
  await flush();
  assert.equal(e.bus.published.length, published, "no stop, no focus, no resolve");
  assert.ok(e.s.ctx.all().some((x) => x.kind === "speech" && x.unfinished));
});

// ---- The person's final -------------------------------------------------------------------------------------------------

test("interject: a final adding fewer than interject_followup_min_words is marked seen and decides nothing, with yield on or off", async () => { // @spec SAL-INTJ-010, SAL-INTJ-013, SAL-TRIG-001
  for (const interject_yield of [true, false]) {
    const e = setup({ interject_yield, barge_in: true, reflexes: [DIED] }, { draw: 0 });
    await spoken(e); // the state is speaking, so a barge-in would act if it were checked
    const published = e.bus.published.length;
    await e.s.onEvent(heard(`${EARLY} please`));
    await flush();
    await e.s.tick();
    assert.equal(e.bus.published.length, published, `yield ${interject_yield}: no stop, no focus, no reflex`);
    const entry = lastSpeech(e);
    assert.ok(entry && entry.kind === "speech");
    assert.equal(entry.text, `${EARLY} please`, "appended as an ordinary line with its full text");
    assert.equal(entry.seen, true);
  }
  // No reflex test and no trigger: the line is idle (not busy) here, so either would otherwise act.
  const e = setup({ reflexes: [DIED] }, { draw: 0 });
  await spoken(e);
  await e.s.onEvent(status("idle"));
  const published = e.bus.published.length;
  await e.s.onEvent(heard(`${EARLY} you died`)); // adds two words and matches the rule
  await flush();
  // The cortex line that answers the request is injected via onEvent, not published, so salience's bus holds no brain.say: a short
  // continuation takes no reflex and publishes nothing.
  assert.equal(says(e).length, 0, "no reflex answer and no brain.say for a short continuation");
  assert.equal(e.bus.published.length, published);
});

test("interject: the added words are the difference of the word counts, never below zero", async () => { // @spec SAL-INTJ-011
  const cases: [string, boolean][] = [
    ["Look AT this one right now yes", true],         // 7 - 4 = 3
    ["look at this one right now", false],            // 6 - 4 = 2
    ["look at this one. right now yes", true],        // 7 - 4 = 3: "one." is one word
    ["look at this one. right now", false],           // 6 - 4 = 2
    ["look at", false],                               // 2 - 4 < 0: never below zero
    ["look", false],                                  // 1 - 4 < 0: never below zero (an absolute difference would give 3)
    ["totally different words here right now ok", true], // 7 - 4 = 3, meets the minimum of 3
    ["totally different words here now ok", false],   // 6 - 4 = 2, below the minimum of 3
  ];
  for (const [fin, yields] of cases) {
    const e = setup({}, { draw: 0 });
    await spoken(e);
    await e.s.onEvent(heard(fin));
    await flush();
    assert.equal(stops(e).length, yields ? 1 : 0, fin);
  }
});

test("interject: with yield on and the line playing the final publishes one yield stop with the line's id, frees the state and cooldown, and is decided with no barge-in check", async () => { // @spec SAL-INTJ-009, SAL-INTJ-013, SAL-INTJ-022, SAL-BARGE-001
  for (const barge_in of [true, false]) {
    const e = setup({ cooldown_ms: 60_000, barge_in }, { draw: 0 });
    await spoken(e, { id: "L7" });
    const fin = `${EARLY} and then some more`;
    await e.s.onEvent(heard(fin));
    await flush();
    assert.deepEqual(stops(e), [{ reason: "yield", ids: ["L7"] }], `barge_in ${barge_in}: one stop, a yield, no barge-in stop`);
    assert.equal(e.s.scheduler.cooling(), false, "the cooldown is cleared");
    assert.equal(focuses(e).length, 2, "the final is decided at once under the ordinary gates");
    assert.equal(focuses(e)[1]!.focus?.text, fin, "the focus is the whole final");
    const types = e.bus.types() as string[];
    assert.ok(types.indexOf("voice.stop") < types.lastIndexOf("attention.focus"));
    const entry = lastSpeech(e);
    assert.ok(entry && entry.kind === "speech" && entry.text === fin, "appended as an ordinary line");
  }
});

test("interject: after the yield stop the final takes the reflex test and the speech trigger", async () => { // @spec SAL-INTJ-022
  const e = setup({ cooldown_ms: 60_000, reflexes: [DIED], barge_in: true }, { draw: 0 });
  await spoken(e, { id: "L7" });
  await e.s.onEvent(heard(`${EARLY} you died now`));
  await flush();
  assert.deepEqual(stops(e), [{ reason: "yield", ids: ["L7"] }]);
  assert.equal(says(e).filter((s) => s.reason === "reflex: you died").length, 1, "the reflex answers the final after the stop");
  const types = e.bus.types() as string[];
  assert.ok(types.indexOf("voice.stop") < types.lastIndexOf("brain.say"));
});

test("interject: a line that is no longer playing is not yielded to: the final takes the ordinary path", async () => { // @spec SAL-INTJ-012, SAL-INTJ-013
  for (const ended of ["status", "valve"] as const) {
    const e = setup({ barge_in: true }, { draw: 0 });
    await spoken(e);
    if (ended === "status") await e.s.onEvent(status("idle"));
    else e.advance(20_001); // the speaking valve ran out
    const fin = `${EARLY} and then some more`;
    await e.s.onEvent(heard(fin));
    await flush();
    assert.equal(stops(e).length, 0, `${ended}: no yield stop (and nothing to barge in on)`);
    assert.equal(focuses(e).length, 2, `${ended}: the ordinary speech trigger decides the final`);
    assert.equal(focuses(e)[1]!.focus?.text, fin);
    const entry = lastSpeech(e);
    assert.ok(entry && entry.kind === "speech" && entry.text === fin);
  }
});

test("interject: yield false publishes no yield stop and the final takes the ordinary barge-in check; with barge_in off the line is not stopped", async () => { // @spec SAL-INTJ-012, SAL-INTJ-017
  const on = setup({ interject_yield: false, barge_in: true }, { draw: 0 });
  await spoken(on);
  await on.s.onEvent(heard(`${EARLY} and then some more`));
  await flush();
  assert.deepEqual(stops(on), [{ reason: "barge-in" }], "the ordinary barge-in rules stop the line");
  const off = setup({ interject_yield: false, barge_in: false }, { draw: 0 });
  await spoken(off);
  await off.s.onEvent(heard(`${EARLY} and then some more`));
  await flush();
  assert.equal(stops(off).length, 0, "no yield stop of any kind");
});

// ---- Early pass guard ---------------------------------------------------------------------------------------------------

test("interject: a later early transcript adding fewer than interject_followup_min_words beyond the interjected text issues no provisional focus", async () => { // @spec SAL-INTJ-015
  const e = setup({}, { draw: 0 });
  await spoken(e);
  await e.s.onEvent(status("idle")); // the line ended, so only the follow-up rule holds the early pass back
  await e.s.onEvent(early(`${EARLY} and`, { seq: 1 }));
  await flush();
  assert.equal(focuses(e).length, 1, "no second provisional focus");
  await e.s.onEvent(early(`${EARLY} and then some`, { seq: 2 }));
  await flush();
  assert.equal(focuses(e).length, 2, "control: three more words start an ordinary early pass");
  assert.equal(focuses(e)[1]!.provisional, true);
});

// ---- A final while the request is pending -------------------------------------------------------------------------------

test("interject: a final during a pending request is held, then handled as spoken when brain.say answers: yield stop, ordered window", async () => { // @spec SAL-INTJ-023, SAL-INTJ-009, SAL-INTJ-013
  const e = setup({}, { draw: 0 });
  await asked(e);
  const fin = `${EARLY} and then some more`;
  const published = e.bus.published.length;
  void e.s.onEvent(heard(fin)); // not awaited: the handler must leave the bus free to deliver the answer
  await flush();
  assert.equal(e.bus.published.length, published, "held: no decision, no stop, no refusal");
  await e.s.onEvent(say("L2"));
  await flush();
  assert.deepEqual(stops(e), [{ reason: "yield", ids: ["L2"] }]);
  assert.equal(focuses(e).length, 2, "the final is then decided");
  const speech = e.s.ctx.all().filter((x) => x.kind === "speech");
  assert.deepEqual(speech.map((x) => x.kind === "speech" && x.unfinished === true), [true, false], "the unfinished line comes before the final");
});

test("interject: a short final held for a request that is then spoken decides nothing", async () => { // @spec SAL-INTJ-023, SAL-INTJ-010
  const e = setup({}, { draw: 0 });
  await asked(e);
  void e.s.onEvent(heard(`${EARLY} please`));
  await flush();
  await e.s.onEvent(say("L2"));
  await flush();
  assert.equal(stops(e).length, 0);
  assert.equal(focuses(e).length, 1);
  const entry = lastSpeech(e);
  assert.ok(entry && entry.kind === "speech" && entry.seen);
});

test("interject: a final held for a request that is dropped takes the ordinary path", async () => { // @spec SAL-INTJ-023
  const e = setup({}, { draw: 0 });
  await asked(e);
  const fin = `${EARLY} and then some more`;
  void e.s.onEvent(heard(fin));
  await flush();
  assert.equal(focuses(e).length, 1, "held while pending");
  await e.s.onEvent(status("idle"));
  await flush();
  assert.equal(stops(e).length, 0);
  assert.equal(focuses(e).length, 2, "decided as an ordinary line");
  assert.equal(focuses(e)[1]!.focus?.text, fin);
});

test("interject: a final held for a request that reaches unresolved_limit_ms takes the ordinary path", async () => { // @spec SAL-INTJ-023, SAL-INTJ-018
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const e = setup({ unresolved_limit_ms: 4000 }, { draw: 0 });
    await asked(e);
    const fin = `${EARLY} and then some more`;
    void e.s.onEvent(heard(fin));
    await flush();
    e.advance(3999);
    await flush();
    assert.equal(focuses(e).length, 1, "still held one millisecond before the limit");
    e.advance(1);
    await flush();
    assert.equal(stops(e).length, 0);
    assert.equal(focuses(e).length, 2, "the limit released it to the ordinary path");
    assert.equal(focuses(e)[1]!.focus?.text, fin);
  } finally { mock.timers.reset(); }
});

// ---- Ruled identity, cortex lines and the reviewed edges ----------------------------------------------------------------------

test("interject: a reflex or operator line during a pending request neither answers it nor charges a gap", async () => { // @spec SAL-INTJ-007, SAL-INTJ-003
  for (const [id, reason] of [["R1", "reflex: you died"], ["OP", "operator"]] as const) {
    const e = setup({}, { draw: 0 });
    await asked(e);
    await e.s.onEvent(say(id, { reason }));
    await flush();
    assert.equal(e.s.ctx.all().some((x) => x.kind === "speech" && x.unfinished), false, `${reason}: no unfinished line`);
    await e.s.onEvent(say("L1")); // still pending: the cortex line answers it
    await flush();
    assert.equal(e.s.ctx.all().some((x) => x.kind === "speech" && x.unfinished), true, `${reason}: the cortex line is recorded`);
  }
  for (const [id, reason] of [["R1", "reflex: you died"], ["OP", "operator"]] as const) {
    const e = setup({}, { draw: 0 });
    await asked(e);
    await e.s.onEvent(say(id, { reason }));
    await e.s.onEvent(status("idle")); // cortex spoke nothing for the request: it is dropped
    await flush();
    await asked(e, EARLY, "u2");
    assert.equal(confirms(e).length, 2, `${reason}: no gap was charged, so the next request is asked at once`);
  }
});

test("interject: a final of another utterance during a pending request is an ordinary line at once", async () => { // @spec SAL-INTJ-023
  const e = setup({}, { draw: 0 });
  await asked(e);
  await e.s.onEvent(heard("someone else talks now", { speaker: "Dana", utteranceId: "u9" }));
  await flush();
  const entry = lastSpeech(e);
  assert.ok(entry && entry.kind === "speech" && entry.text === "someone else talks now" && entry.speaker === "Dana", "appended before the answer");
});

test("interject: a final during a pending request does not yield when another line set speaking later", async () => { // @spec SAL-INTJ-009
  for (const [id, reason] of [["R1", "reflex: you died"], ["OP", "operator"], ["L8", "engaged"]] as const) {
    const e = setup({ barge_in: false }, { draw: 0 });
    await spoken(e, { id: "L7" });
    await e.s.onEvent(say(id, { reason }));
    await e.s.onEvent(heard(`${EARLY} and then some more`));
    await flush();
    assert.equal(stops(e).length, 0, `${reason}: no yield stop for the interjected line L7`);
  }
});

test("interject: forget_context drops a pending request and its held finals, leaves cortex not busy, and charges no gap", async () => { // @spec SAL-INTJ-024
  const e = setup({}, { draw: 0 });
  await asked(e);
  const fin = `${EARLY} and then some more`;
  void e.s.onEvent(heard(fin)); // held for the pending request
  await flush();
  await e.s.onEvent(event("control", { cmd: "forget_context" }));
  await flush();
  assert.equal(e.s.ctx.all().length, 0, "the window is cleared");
  assert.equal(focuses(e).length, 1, "no decision for the held final");
  // Not busy after forget: a new early pass is taken at once (it is refused while cortex is thinking), and the gap is not charged.
  await asked(e, EARLY, "u2");
  assert.equal(confirms(e).length, 2, "the next request is asked at once: no gap was charged by the forgotten one");
  await e.s.onEvent(say("L2")); // cortex answers the new request
  await flush();
  assert.equal(e.s.ctx.all().some((x) => x.kind === "speech" && x.text === fin), false, "the forgotten final never re-enters");
  const unfinished = e.s.ctx.all().filter((x) => x.kind === "speech" && x.unfinished);
  assert.deepEqual(unfinished.map((x) => x.kind === "speech" && x.text), [EARLY], "only the new request's early text is pushed");
});

test("interject: a final that is short against a provisional follow-up withdraws that focus as resumed, so cortex is not left thinking", async () => { // @spec SAL-INTJ-010
  const e = setup({}, { draw: 0 });
  await spoken(e);
  await e.s.onEvent(status("idle"));
  await e.s.onEvent(early(`${EARLY} and then some`, { seq: 1 })); // a provisional focus held for seq 1
  await flush();
  assert.equal(focuses(e)[1]!.provisional, true, "precondition: a provisional follow-up is held");
  await e.s.onEvent(heard(`${EARLY} please`)); // adds one word beyond the interjected text
  await flush();
  assert.deepEqual(withdraws(e).map((w) => [w.seq, w.reason]), [[1, "resumed"]], "the held follow-up is withdrawn");
  await e.s.onEvent(chat("hey Coco?", { mentionsCohost: true, user: "carol" }));
  await e.s.tick();
  assert.equal(focuses(e).length, 3, "not thinking: the chat mention is decided");
});

test("interject: with two records for one utterance the most recent one decides the final", async () => { // @spec SAL-INTJ-021
  const e = setup({ barge_in: true }, { draw: 0 });
  await spoken(e, { id: "L1" }); // record 1: the early text
  await e.s.onEvent(status("idle"));
  e.advance(120_000);
  const second = `${EARLY} and then some`;
  await asked(e, second, "u1", 1); // record 2 for the same utterance: a longer text
  assert.equal(confirms(e).length, 2, "precondition: a second interjection of u1");
  await e.s.onEvent(say("L2"));
  await flush();
  // Against record 2 this final adds one word (short: no stop). Against record 1 it adds four, a barge-in on the line playing.
  await e.s.onEvent(heard(`${EARLY} and then some more`, { utteranceId: "u1" }));
  await flush();
  assert.deepEqual(stops(e), [], "the most recent record decides: the short continuation publishes nothing");
});

test("interject: a refused yield stop leaves the state and cooldown as they were and takes no barge-in check", async () => { // @spec SAL-INTJ-009, SAL-BARGE-009
  const e = setup({ cooldown_ms: 60_000, barge_in: true }, { draw: 0 });
  await spoken(e, { id: "L7" });
  const refusedTypes = refuse(e, (t) => t === "voice.stop");
  await e.s.onEvent(heard(`${EARLY} and then some more`));
  await flush();
  assert.deepEqual(refusedTypes, ["voice.stop"], "one attempt: the yield, and no barge-in stop after it");
  assert.equal(stops(e).length, 0, "nothing was published");
  assert.equal(e.s.scheduler.cooling(), true, "the cooldown is not cleared");
  assert.equal(focuses(e).length, 1, "still speaking: the final takes no new focus");
});

test("interject: a refused confirm makes no request, withdraws the focus, and releases the held finals to the ordinary path", async () => { // @spec SAL-INTJ-006, SAL-INTJ-023
  const e = setup({}, { draw: 0 });
  await e.s.onEvent(early(EARLY));
  await flush();
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const refusedTypes = refuse(e, (t, d) => t === "attention.resolve" && (d as { interjected?: boolean }).interjected === true, { once: true, gate });
  const retraction = e.s.onEvent(retracted(0));
  await flush();
  const fin = `${EARLY} and then some more`;
  void e.s.onEvent(heard(fin)); // the request is pending while its confirm is in flight: the final is held
  await flush();
  assert.equal(focuses(e).length, 1, "held while the confirm is in flight");
  open();
  await retraction;
  await flush();
  assert.deepEqual(refusedTypes, ["attention.resolve"]);
  assert.equal(confirms(e).length, 0, "no interjected confirm reached the bus");
  assert.deepEqual(withdraws(e).map((w) => w.reason), ["resumed"], "cortex is left with no provisional focus");
  assert.equal(stops(e).length, 0);
  assert.equal(focuses(e).length, 2, "the held final is decided as an ordinary line");
  assert.equal(focuses(e)[1]!.focus?.text, fin);
  assert.equal(e.s.ctx.all().some((x) => x.kind === "speech" && x.unfinished), false, "no unfinished line");
});

test("interject: the interjected confirm's speech focus carries the speakerId of the early transcript", async () => { // @spec SAL-FOCUS-008
  const e = setup({}, { draw: 0.1 });
  await asked(e, EARLY, "u1", 3, { speakerId: "D1" });
  assert.deepEqual(resolves(e)[0]!.focus, { kind: "speech", who: "Chris", speakerId: "D1", text: EARLY, source: "discord", mention: false });
});
