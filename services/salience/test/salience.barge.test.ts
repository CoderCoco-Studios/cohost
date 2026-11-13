import { test } from "node:test";
import assert from "node:assert/strict";
import { ModuleSchema } from "@cohost/config";
import { Module } from "@cohost/modules";
import { FakeBus, event, recordingLog, silentLog, testConfig } from "@cohost/testing";
import { Salience } from "../src/salience.js";
import { scoreRules, type ScoreInput, type ScoreOutput } from "../src/scoring.js";

// Barge-in (SAL-BARGE-*): a final speech.heard while the co-host is speaking publishes voice.stop. The clock is a hand-advanced fake.

const DIED = { match: "you died", say: ["Oof."], emotion: "surprised", gesture: "facepalm", cooldown_ms: 0 };

function setup(salience: Record<string, unknown> = {}, cortex: Record<string, unknown> = {}, log: typeof silentLog = silentLog) {
  const cfg = testConfig({ brain: { salience: { cooldown_ms: 0, idle_chatter_ms: 0, barge_in: true, ...salience }, cortex } });
  const bus = new FakeBus();
  let t = 1_000_000;
  const scorer = new Module<ScoreInput, ScoreOutput>("s", ModuleSchema.parse({}), cfg.llm, { rules: (i) => scoreRules(i, true) }, silentLog);
  const s = new Salience({ cfg, bus, scorer, log, now: () => t });
  return { s, bus, advance: (ms: number) => { t += ms; } };
}
const speech = (text: string, extra: Record<string, unknown> = {}) =>
  event("speech.heard", { speaker: "Chris", text, durationMs: 900, source: "discord", ...extra });
const say = (reason?: string) => event("brain.say", { id: "x", text: "hello there", emotion: "happy", ...(reason ? { reason } : {}) });
const status = (state: "idle" | "thinking" | "speaking" | "muted") => event("brain.status", { state });
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
const stops = (bus: FakeBus) => bus.of("voice.stop" as never) as unknown as { reason: string; ids?: string[] }[];

// @spec SAL-BARGE-001
test("barge-in: a qualifying final speech.heard while speaking publishes one voice.stop with reason barge-in and no ids", async () => {
  const { s, bus } = setup();
  await s.onEvent(say());
  await s.onEvent(speech("wait stop"));
  await flush();
  assert.equal(stops(bus).length, 1);
  assert.equal(stops(bus)[0]!.reason, "barge-in");
  assert.equal(stops(bus)[0]!.ids, undefined, "no ids: every line");
});

// @spec SAL-BARGE-001
test("barge-in: the voice.stop is published before the line's reflex is evaluated", async () => {
  const { s, bus } = setup({ reflexes: [DIED] });
  await s.onEvent(say());
  await s.onEvent(speech("you died"));
  await flush();
  const types = bus.types() as string[];
  assert.ok(types.includes("voice.stop") && types.includes("brain.say"), "the stop, then the reflex answer");
  assert.ok(types.indexOf("voice.stop") < types.indexOf("brain.say"));
});

// @spec SAL-BARGE-002, SAL-BARGE-003
test("barge-in: the cortex state goes idle and the cooldown clears, so the interrupter's line is decided at once", async () => {
  const { s, bus } = setup({ cooldown_ms: 60_000 });
  await s.onEvent(say());
  await s.onEvent(speech("wait stop"));
  await flush();
  assert.equal(stops(bus).length, 1);
  assert.equal(bus.of("attention.focus").length, 1, "not held back by the busy or cooldown gate");
  assert.deepEqual(bus.of("attention.focus")[0]!.focus, { kind: "speech", who: "Chris", text: "wait stop", mention: false });
});

// @spec SAL-BARGE-002, SAL-BARGE-003
test("barge-in: a reflex matching the interrupting line fires after the stop although a cooldown was running", async () => {
  const { s, bus } = setup({ cooldown_ms: 60_000, reflexes: [DIED] });
  await s.onEvent(say());
  await s.onEvent(speech("you died"));
  await flush();
  assert.equal(stops(bus).length, 1);
  assert.equal(bus.of("brain.say").length, 1);
  assert.equal(bus.of("brain.say")[0]!.reason, "reflex: you died");
});

// @spec SAL-BARGE-003
test("barge-in: the stop itself publishes no attention.focus and no brain.say", async () => {
  const { s, bus } = setup({ trigger_on_speech: false });
  await s.onEvent(say());
  await s.onEvent(speech("wait stop"));
  await flush();
  assert.equal(stops(bus).length, 1);
  assert.equal(bus.of("attention.focus").length, 0);
  assert.equal(bus.of("brain.say").length, 0);
});

// @spec SAL-BARGE-004
test("barge-in: a speech.heard with no source, or a source outside barge_in_sources, is not a barge-in", async () => {
  const { s, bus } = setup();
  await s.onEvent(say());
  const noSource = event("speech.heard", { speaker: "Chris", text: "wait stop", durationMs: 900 });
  await s.onEvent(noSource);
  await s.onEvent(speech("wait stop", { source: "desktop" }));
  await s.onEvent(speech("wait stop", { source: "http" }));
  assert.equal(stops(bus).length, 0);
  const wide = setup({ barge_in_sources: ["desktop", "http"] });
  await wide.s.onEvent(say());
  await wide.s.onEvent(speech("wait stop", { source: "desktop" }));
  assert.equal(stops(wide.bus).length, 1, "a listed source qualifies");
  const discordOnlyDefault = setup();
  await discordOnlyDefault.s.onEvent(say());
  await discordOnlyDefault.s.onEvent(speech("wait stop", { source: "discord" }));
  assert.equal(stops(discordOnlyDefault.bus).length, 1, "discord is the default");
});

// @spec SAL-BARGE-005
test("barge-in: words are whitespace-separated tokens with a letter or number in any script; fewer than barge_in_min_words does not stop", async () => {
  const cases: [string, number, boolean][] = [
    ["mm-hm", 2, false], ["uh", 2, false], ["... --- !!", 2, false], ["wait ...", 2, false], ["", 2, false],
    ["wait stop", 2, true], ["3 4", 2, true], ["ちょっと 待って", 2, true], ["привет мир", 2, true], ["wait ... stop", 2, true],
    ["uh", 1, true], ["...", 1, false], ["a b c", 4, false], ["a b c d", 4, true],
  ];
  for (const [text, min, stops_] of cases) {
    const { s, bus } = setup({ barge_in_min_words: min });
    await s.onEvent(say());
    await s.onEvent(speech(text));
    assert.equal(stops(bus).length, stops_ ? 1 : 0, `${JSON.stringify(text)} with min ${min}`);
  }
});

// @spec SAL-BARGE-006
test("barge-in: a reflex line is never interrupted, from the moment the reflex brain.say is published, before its echo", async () => {
  const { s, bus } = setup({ reflexes: [DIED] });
  await s.onEvent(speech("you died", { source: "http" })); // the reflex fires and marks the voice speaking
  assert.equal(bus.of("brain.say").length, 1);
  await s.onEvent(speech("wait stop"));
  await flush();
  assert.equal(stops(bus).length, 0, "no echo has arrived yet");
  await s.onEvent(say("reflex: you died")); // the echo
  await s.onEvent(speech("wait stop"));
  assert.equal(stops(bus).length, 0);
});

// @spec SAL-BARGE-006
test("barge-in: a brain.say whose reason begins reflex: is exempt until a later brain.say without that prefix", async () => {
  const { s, bus } = setup();
  await s.onEvent(say("reflex: operator"));
  await s.onEvent(speech("wait stop"));
  assert.equal(stops(bus).length, 0);
  await s.onEvent(say("engaged"));
  await s.onEvent(speech("wait stop"));
  assert.equal(stops(bus).length, 1, "the exemption ended");
  const noReason = setup();
  await noReason.s.onEvent(say("reflex: a"));
  await noReason.s.onEvent(say());
  await noReason.s.onEvent(speech("wait stop"));
  assert.equal(stops(noReason.bus).length, 1, "a brain.say with no reason also ends it");
});

// @spec SAL-BARGE-007
test("barge-in: not speaking, or speaking longer than speaking_timeout_ms, publishes no voice.stop", async () => {
  for (const state of ["idle", "thinking", "muted"] as const) {
    const { s, bus } = setup();
    await s.onEvent(status(state));
    await s.onEvent(speech("wait stop"));
    assert.equal(stops(bus).length, 0, state);
  }
  const fresh = setup();
  await fresh.s.onEvent(speech("wait stop"));
  assert.equal(stops(fresh.bus).length, 0, "initial idle state");
  const { s, bus, advance } = setup({}, { speaking_timeout_ms: 1000 });
  await s.onEvent(say());
  advance(1500);
  await s.onEvent(speech("wait stop"));
  assert.equal(stops(bus).length, 0);
});

// @spec SAL-BARGE-008
test("barge-in: while paused or muted, no voice.stop", async () => {
  const paused = setup();
  await paused.s.onEvent(say());
  await paused.s.onEvent(event("control", { cmd: "pause" }));
  await paused.s.onEvent(speech("wait stop"));
  assert.equal(stops(paused.bus).length, 0);
  await paused.s.onEvent(event("control", { cmd: "resume" }));
  await paused.s.onEvent(speech("wait stop"));
  assert.equal(stops(paused.bus).length, 1, "resume restores it");
  const muted = setup();
  await muted.s.onEvent(say());
  await muted.s.onEvent(event("control", { cmd: "mute" }));
  await muted.s.onEvent(speech("wait stop"));
  assert.equal(stops(muted.bus).length, 0);
});

// @spec SAL-BARGE-009
test("barge-in: a failed voice.stop publish is logged and leaves the state and cooldown, so the line is busy-gated", async () => {
  const rec = recordingLog();
  const { s, bus } = setup({ cooldown_ms: 60_000 }, {}, rec.log);
  bus.fail = (type) => (type as string) === "voice.stop";
  await s.onEvent(say());
  await s.onEvent(speech("wait stop"));
  await flush();
  assert.ok(rec.msgs("error").length >= 1 || rec.lines.some((l) => l.level === "error"), "the failure is logged");
  assert.equal(stops(bus).length, 0);
  assert.equal(bus.of("attention.focus").length, 0, "still busy and cooling down");
  await s.tick();
  assert.equal(bus.of("attention.focus").length, 0);
});

// @spec SAL-BARGE-010
test("barge-in: after a barge-in and until a new brain.say, no further voice.stop whatever the speaker", async () => {
  const { s, bus } = setup();
  await s.onEvent(say());
  await s.onEvent(speech("wait stop"));
  assert.equal(stops(bus).length, 1);
  await s.onEvent(status("speaking")); // the interrupted line's status still in flight
  await s.onEvent(speech("hey you there", { speaker: "Dana" }));
  await s.onEvent(speech("another thing now", { speaker: "Chris" }));
  assert.equal(stops(bus).length, 1);
  await s.onEvent(say("engaged"));
  await s.onEvent(speech("wait stop"));
  assert.equal(stops(bus).length, 2, "a new line can be interrupted");
});

// @spec SAL-BARGE-011
test("barge-in: with barge_in false no voice.stop is published and speech.heard is handled as before", async () => {
  const off = setup({ barge_in: false });
  await off.s.onEvent(say());
  await off.s.onEvent(speech("wait stop"));
  await flush();
  assert.equal(stops(off.bus).length, 0);
  assert.equal(off.bus.of("attention.focus").length, 0, "busy gate holds the focus back as before");
  const dflt = testConfig({ brain: { salience: {} } });
  assert.equal((dflt.brain.salience as unknown as Record<string, unknown>).barge_in, false);
});
