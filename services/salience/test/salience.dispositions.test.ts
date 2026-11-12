import { test } from "node:test";
import assert from "node:assert/strict";
import { ModuleSchema } from "@cohost/config";
import { Module } from "@cohost/modules";
import { FakeBus, event, silentLog, testConfig } from "@cohost/testing";
import { Salience } from "../src/salience.js";
import { scoreRules, type ScoreInput, type ScoreOutput } from "../src/scoring.js";

const DIED = { match: "you died", say: ["Oof."], emotion: "surprised", gesture: "facepalm", cooldown_ms: 0 };

/** A Salience on a controllable monotonic clock; the scorer defaults to the rules weights and records every input. */
function setup(salience: Record<string, unknown> = {}, opts: { zeros?: boolean; extra?: Record<string, unknown> } = {}) {
  let clock = 1_000_000;
  const cfg = testConfig({ brain: { salience: { cooldown_ms: 0, idle_chatter_ms: 0, ...salience } }, ...(opts.extra ?? {}) });
  const bus = new FakeBus();
  const inputs: ScoreInput[] = [];
  const scorer = new Module<ScoreInput, ScoreOutput>("s", ModuleSchema.parse({}), cfg.llm, {
    rules: (i) => { inputs.push(i); return opts.zeros ? { scores: i.events.map(() => 0) } : scoreRules(i, true); },
  }, silentLog);
  const details: (string | undefined)[] = [];
  const s = new Salience({ cfg, bus, scorer, log: silentLog, now: () => clock, heartbeat: { setDetail: (d) => details.push(d) } });
  return { s, bus, inputs, details, advance: (ms: number) => { clock += ms; } };
}
const chat = (text: string, extra: Record<string, unknown> = {}) =>
  event("chat.message", { platform: "twitch", user: "bob", text, isMod: false, isSub: false, mentionsCohost: false, ...extra });
const idle = event("brain.status", { state: "idle" });
const texts = (s: { ctx: { unseen(): unknown[] } }) => s.ctx.unseen().map((e) => (e as { text: string }).text);

test("resume: events taken in while paused are marked seen, so no stale burst is scored", async () => { // @spec SAL-CTRL-007
  const { s, bus } = setup();
  await s.onEvent(event("control", { cmd: "pause" }));
  await s.onEvent(chat("hey Coco?", { mentionsCohost: true }));
  await s.onEvent(event("speech.heard", { speaker: "Chris", text: "while you were away", durationMs: 800 }));
  assert.equal(s.ctx.unseen().length, 2, "taken in, still unseen while paused");
  await s.onEvent(event("control", { cmd: "resume" }));
  assert.equal(s.ctx.unseen().length, 0, "marked seen on resume");
  await s.tick();
  assert.equal(bus.of("attention.focus").length, 0, "nothing stale to answer");
  await s.onEvent(chat("hey Coco, still here?", { mentionsCohost: true })); // after the resume: unseen as usual
  await s.tick();
  assert.equal(bus.of("attention.focus").length, 1);
});

test("resume: an event from before the pause is not touched, and a resume for another service marks nothing", async () => { // @spec SAL-CTRL-007
  const { s } = setup();
  await s.onEvent(chat("before"));
  await s.onEvent(event("control", { cmd: "pause", target: "salience" }));
  await s.onEvent(chat("during"));
  await s.onEvent(event("control", { cmd: "resume", target: "cortex" })); // not for us: still paused
  assert.deepEqual(texts(s), ["before", "during"]);
  await s.onEvent(event("control", { cmd: "resume", target: "salience" }));
  assert.deepEqual(texts(s), ["before"]);
});

test("reflex: the triggering event comes from the push, not from the window's last entry", async () => { // @spec SAL-REFLEX-008, SAL-REFLEX-004
  const { s, bus } = setup({ reflexes: [DIED] });
  s.ctx.last = () => { throw new Error("the reflex must not read the window's last entry"); };
  await s.onEvent(chat("hello"));
  await s.onEvent(chat("lol you died", { injected: true, remember: true }));
  const [say] = bus.of("brain.say");
  assert.equal(say!.injected, true);
  assert.equal(say!.remember, true);
  assert.deepEqual(texts(s), ["hello"], "only the trigger was marked seen");
});

test("pause is reported in the heartbeat detail and cleared by resume", async () => { // @spec SAL-HEALTH-004
  const { s, details } = setup();
  await s.onEvent(event("control", { cmd: "pause", target: "cortex" }));
  assert.deepEqual(details, [], "a pause for another service reports nothing");
  await s.onEvent(event("control", { cmd: "pause" }));
  await s.onEvent(event("control", { cmd: "resume" }));
  assert.deepEqual(details, ["paused", undefined]);
});

// ---- the test gaps of the LLD

test("affect.state arousal is forwarded in the scorer input", async () => { // @spec SAL-IN-004
  const { s, inputs } = setup();
  await s.onEvent(event("affect.state", { valence: 0.2, arousal: 0.7, mood: "happy" }));
  await s.onEvent(chat("hey Coco?", { mentionsCohost: true }));
  await s.tick();
  assert.equal(inputs.at(-1)!.arousal, 0.7);
});

test("chat and speech reset the idle timer; vision does not", async () => { // @spec SAL-IN-002, SAL-IN-003
  const idleMs = 10_000;
  const cases = [
    ["chat", chat("hm"), true],
    ["speech", event("speech.heard", { speaker: "Chris", text: "hm", durationMs: 100 }), true],
    ["vision", event("vision.summary", { text: "menu", changed: true }), false],
  ] as const;
  for (const [name, ev, resets] of cases) {
    const { s, bus, advance } = setup({ idle_chatter_ms: idleMs, speak_threshold: 5 });
    advance(idleMs - 1_000);
    await s.onEvent(ev);
    advance(2_000); // past idle_chatter_ms since boot, but only 2 s since the event
    await s.tick();
    assert.equal(bus.of("attention.focus").length, resets ? 0 : 1, `${name} ${resets ? "reset" : "did not reset"} the idle timer`);
  }
});

test("nothing new wins over an elapsed idle timer, so a silent stream stays silent", async () => { // @spec SAL-DECIDE-005
  const { s, bus, advance } = setup({ idle_chatter_ms: 1_000 });
  advance(60_000);
  await s.tick();
  assert.equal(bus.of("attention.focus").length, 0);
});

test("a decision below the threshold reports `score <total> < <threshold>`", async () => { // @spec SAL-DECIDE-006
  const { s } = setup({ speak_threshold: 0.6 });
  await s.onEvent(chat("plain"));
  const d = await s.scheduler.decide(s.ctx, false, false, 0);
  assert.equal(d.speak, false);
  assert.equal(d.reason, "score 0.15 < 0.60");
});

test("reflex rules match in config order: the first matching rule wins", async () => { // @spec SAL-REFLEX-003
  const first = { match: "died", say: ["first"], emotion: "sad", cooldown_ms: 0 };
  const second = { match: "you died", say: ["second"], emotion: "happy", cooldown_ms: 0 };
  const { s, bus } = setup({ reflexes: [first, second] });
  await s.onEvent(chat("you died"));
  assert.equal(bus.of("brain.say")[0]!.text, "first");
});

test("a gated reflex does not spend its rule's own cooldown", async () => { // @spec SAL-REFLEX-005
  const rule = { ...DIED, cooldown_ms: 60_000 };
  const { s, bus } = setup({ reflexes: [rule] });
  await s.onEvent(event("brain.status", { state: "thinking" }));
  await s.onEvent(chat("you died")); // gated: cortex busy
  assert.equal(bus.of("brain.say").length, 0);
  await s.onEvent(idle);
  await s.onEvent(chat("you died again"));
  assert.equal(bus.of("brain.say").length, 1, "the rule was still ready once the gate opened");
});

test("with no focus event the attention.focus carries neither injection flag", async () => { // @spec SAL-INJ-002
  const { s, bus, advance } = setup({ idle_chatter_ms: 1_000, speak_threshold: 5 }, { zeros: true });
  await s.onEvent(chat("quiet", { injected: true, remember: true })); // scores 0: it can never be the focus
  advance(2_000);
  await s.tick();
  const [f] = bus.of("attention.focus");
  assert.equal(f!.reason, "idle chatter");
  assert.equal(f!.focus, undefined);
  assert.equal("injected" in f! || "remember" in f!, false);
});

test("a cortex that reports muted is not busy", async () => { // @spec SAL-BUSY-004
  const { s, bus } = setup();
  await s.onEvent(event("brain.status", { state: "muted" }));
  await s.onEvent(chat("hey Coco?", { mentionsCohost: true }));
  await s.tick();
  assert.equal(bus.of("attention.focus").length, 1);
});

test("a fresh salience has arousal 0, an idle cortex and is neither muted nor paused", async () => { // @spec SAL-IN-006, SAL-CTRL-006
  const first = setup();
  await first.s.onEvent(event("control", { cmd: "pause" }));
  await first.s.onEvent(event("control", { cmd: "mute" }));
  await first.s.onEvent(event("affect.state", { valence: 0, arousal: 0.9, mood: "laugh" }));
  const restarted = setup(); // a restart is a new instance: all of it was in memory only
  await restarted.s.onEvent(chat("hey Coco?", { mentionsCohost: true }));
  await restarted.s.tick();
  assert.equal(restarted.inputs[0]!.arousal, 0);
  assert.equal(restarted.bus.of("attention.focus").length, 1, "idle cortex, not muted, not paused: it decided");
});

test("the salience window is sized by brain.working_memory_events", async () => { // @spec WM-WIN-005
  const { s } = setup({}, { extra: { brain: { working_memory_events: 3 } } });
  for (const t of ["a", "b", "c", "d", "e"]) await s.onEvent(chat(t));
  assert.deepEqual(s.ctx.all().map((e) => (e as { text: string }).text), ["c", "d", "e"]);
});
