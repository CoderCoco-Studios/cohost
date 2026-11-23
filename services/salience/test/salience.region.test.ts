import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { ModuleSchema } from "@cohost/config";
import { Module } from "@cohost/modules";
import { FakeBus, event, recordingLog, silentLog, testConfig } from "@cohost/testing";
import { Salience } from "../src/salience.js";
import { scoreRules, type ScoreInput, type ScoreOutput } from "../src/scoring.js";

const DIED = { match: "you died", say: ["Oof."], emotion: "surprised", gesture: "facepalm", cooldown_ms: 0 };

function setup(salience: Record<string, unknown> = {}, extra: Record<string, unknown> = {}, now?: () => number) {
  const cfg = testConfig({ brain: { salience: { cooldown_ms: 0, idle_chatter_ms: 0, ...salience } }, ...extra });
  const bus = new FakeBus();
  let scorerCalls = 0;
  let gate: Promise<void> | undefined;
  const scorer = new Module<ScoreInput, ScoreOutput>("s", ModuleSchema.parse({}), cfg.llm, {
    rules: (i) => { scorerCalls++; return scoreRules(i, true); },
  }, silentLog);
  const run = scorer.run.bind(scorer);
  scorer.run = async (i) => { if (gate) await gate; return run(i); };
  const s = new Salience({ cfg, bus, scorer, log: silentLog, now });
  return { s, bus, calls: () => scorerCalls, setGate: (g?: Promise<void>) => { gate = g; } };
}
const chat = (text: string, extra: Record<string, unknown> = {}) =>
  event("chat.message", { platform: "twitch", user: "bob", text, isMod: false, isSub: false, mentionsCohost: false, ...extra });
const idle = event("brain.status", { state: "idle" });

test("tick: a mention publishes attention.focus naming who and what", async () => { // @spec SAL-FOCUS-003, SAL-FOCUS-004, SAL-DECIDE-002
  const { s, bus } = setup();
  await s.onEvent(chat("plain"));
  await s.onEvent(chat("hey Coco?", { mentionsCohost: true }));
  await s.tick();
  const [focus] = bus.of("attention.focus");
  assert.equal(focus!.reason, "mentioned");
  assert.ok(Math.abs(focus!.score - 1.0) < 1e-9); // "plain" is the same viewer: discounted
  assert.deepEqual(focus!.focus, { kind: "chat", who: "bob", text: "hey Coco?", mention: true });
  assert.equal(s.ctx.unseen().length, 0, "what was scored is now seen");
});

test("tick: speech and vision focus are mapped for the cortex", async () => { // @spec SAL-FOCUS-003
  const sp = setup({ trigger_on_speech: false }); // this test exercises the poll's mapping; the trigger is covered in salience.trigger.test.ts
  await sp.s.onEvent(event("speech.heard", { speaker: "Chris", text: "look at this", durationMs: 900 }));
  await sp.s.tick();
  assert.deepEqual(sp.bus.of("attention.focus")[0]!.focus, { kind: "speech", who: "Chris", text: "look at this", mention: false });

  const vi = setup({ speak_threshold: 0.3 });
  await vi.s.onEvent(event("vision.summary", { text: "a dragon appears", changed: true }));
  await vi.s.tick();
  assert.deepEqual(vi.bus.of("attention.focus")[0]!.focus, { kind: "vision", text: "a dragon appears", mention: false });
});

test("tick: after firing, it treats the cortex as busy until the cortex reports back", async () => { // @spec SAL-FOCUS-004, SAL-IN-005, SAL-BUSY-004
  const { s, bus } = setup();
  await s.onEvent(chat("hey Coco?", { mentionsCohost: true }));
  await s.tick();
  await s.onEvent(chat("Coco again?", { mentionsCohost: true }));
  await s.tick();
  assert.equal(bus.of("attention.focus").length, 1);
  await s.onEvent(idle);
  await s.tick();
  assert.equal(bus.of("attention.focus").length, 2);
});

test("a speaking cortex blocks focus until done, with a speaking_timeout_ms safety valve", async () => { // @spec SAL-BUSY-002, SAL-BUSY-003
  const { s, bus } = setup({}, { brain: { salience: { cooldown_ms: 0, idle_chatter_ms: 0 }, cortex: { speaking_timeout_ms: 30 } } });
  await s.onEvent(event("brain.say", { id: "x", text: "hi", emotion: "happy" }));
  await s.onEvent(chat("hey Coco?", { mentionsCohost: true }));
  await s.tick();
  assert.equal(bus.of("attention.focus").length, 0);
  await new Promise((r) => setTimeout(r, 40));
  await s.tick();
  assert.equal(bus.of("attention.focus").length, 1);
});

test("the speaking_timeout_ms safety valve measures elapsed time, not the wall clock: a clock stepped back does not extend it", async () => { // @spec SAL-BUSY-002
  const { s, bus } = setup({}, { brain: { salience: { cooldown_ms: 0, idle_chatter_ms: 0 }, cortex: { speaking_timeout_ms: 30 } } });
  await s.onEvent(event("brain.say", { id: "x", text: "hi", emotion: "happy" }));
  const realNow = Date.now.bind(Date);
  const stepped = mock.method(Date, "now", () => realNow() - 25_000); // e.g. an NTP / VM time-sync step
  try {
    await s.onEvent(chat("hey Coco?", { mentionsCohost: true }));
    await new Promise((r) => setTimeout(r, 40));
    await s.tick();
    assert.equal(bus.of("attention.focus").length, 1, "the valve opened after 40 ms of real time");
  } finally { stepped.mock.restore(); }
});

test("brain.say from anyone starts the cooldown", async () => { // @spec SAL-BUSY-003
  const { s, bus } = setup({ cooldown_ms: 60_000 });
  await s.onEvent(event("brain.say", { id: "x", text: "hi", emotion: "happy" }));
  await s.onEvent(idle);
  await s.onEvent(chat("hey Coco?", { mentionsCohost: true }));
  await s.tick();
  assert.equal(bus.of("attention.focus").length, 0);
});

test("mute / unmute / forget_context", async () => { // @spec SAL-CTRL-004, SAL-CTRL-005
  const { s, bus } = setup();
  await s.onEvent(event("control", { cmd: "mute" }));
  await s.onEvent(chat("hey Coco?", { mentionsCohost: true }));
  await s.tick();
  assert.equal(bus.of("attention.focus").length, 0);
  await s.onEvent(event("control", { cmd: "forget_context" }));
  assert.equal(s.ctx.all().length, 0);
  await s.onEvent(event("control", { cmd: "unmute" }));
  await s.onEvent(chat("hey Coco?", { mentionsCohost: true }));
  await s.tick();
  assert.equal(bus.of("attention.focus").length, 1);
});

test("an excited mood lowers the bar to speak", async () => { // @spec SAL-IN-004, SAL-DECIDE-003
  const { s, bus } = setup({ speak_threshold: 0.6, arousal_bias: 0.5 });
  for (const t of ["a", "b", "c"]) await s.onEvent(chat(t)); // one viewer: 0.15
  await s.tick();
  assert.equal(bus.of("attention.focus").length, 0);
  await s.onEvent(event("affect.state", { valence: 0.5, arousal: 1, mood: "laugh" }));
  await s.tick();
  assert.equal(bus.of("attention.focus")[0]!.reason, "engaged");
});

test("ticks don't overlap: a slow scorer is asked once", async () => { // @spec SAL-FOCUS-002
  const { s, bus, calls, setGate } = setup();
  let release!: () => void;
  setGate(new Promise<void>((r) => (release = r)));
  await s.onEvent(chat("hey Coco?", { mentionsCohost: true }));
  const first = s.tick();
  await s.tick(); // skipped while the first is deciding
  release();
  await first;
  assert.equal(calls(), 1);
  assert.equal(bus.of("attention.focus").length, 1);
});

const RAID = { match: "raid", say: ["Raid!"], emotion: "happy", cooldown_ms: 1000 };
test("a flood ticked inside a reflex's cooldown leaves its next fire time alone", async () => { // @spec SAL-DECIDE-016
  let t = 0;
  const { s, bus } = setup({ reflexes: [RAID] }, {}, () => t);
  await s.onEvent(chat("raid incoming")); // t=0: fires and starts the rule's cooldown
  assert.equal(bus.of("brain.say").length, 1);
  await s.onEvent(idle); // the cortex is idle again; only the rule's own cooldown gates the next fire
  for (let i = 0; i < 20; i++) await s.onEvent(chat(`raid ${i}`)); // a flood, all inside that cooldown
  t = 500;
  await s.tick(); // the walk counts the flood (one viewer, one text family): no speak, no reflex state touched
  assert.equal(bus.of("brain.say").length, 1, "no extra line while the rule is cooling");
  t = 1001;
  await s.onEvent(chat("raid again")); // the rule's own next fire time is unchanged
  assert.equal(bus.of("brain.say").length, 2);
});

test("reflex: fires brain.say instantly and marks only its trigger seen", async () => { // @spec SAL-REFLEX-001, SAL-REFLEX-004
  const { s, bus } = setup({ reflexes: [DIED] });
  await s.onEvent(chat("hello"));
  await s.onEvent(chat("lol you died"));
  const [say] = bus.of("brain.say");
  assert.deepEqual([say!.text, say!.emotion, say!.gesture, say!.reason], ["Oof.", "surprised", "facepalm", "reflex: you died"]);
  assert.deepEqual(s.ctx.unseen().map((e) => e.text), ["hello"]);
});

test("reflex: listens on speech, and on vision only when the screen changed", async () => { // @spec SAL-REFLEX-001, SAL-REFLEX-002
  const { s, bus } = setup({ reflexes: [DIED] });
  await s.onEvent(event("vision.summary", { text: "YOU DIED", changed: false }));
  assert.equal(bus.of("brain.say").length, 0);
  await s.onEvent(event("vision.summary", { text: "YOU DIED", changed: true }));
  assert.equal(bus.of("brain.say").length, 1);
  const sp = setup({ reflexes: [DIED] });
  await sp.s.onEvent(event("speech.heard", { speaker: "Chris", text: "aaand you died", durationMs: 800 }));
  assert.equal(sp.bus.of("brain.say").length, 1);
});

test("reflex: never talks over the cortex, inside the cooldown, or while muted", async () => { // @spec SAL-REFLEX-005, SAL-REFLEX-006, SAL-BUSY-001
  const busy = setup({ reflexes: [DIED] });
  await busy.s.onEvent(event("brain.status", { state: "thinking" }));
  await busy.s.onEvent(chat("you died"));
  assert.equal(busy.bus.of("brain.say").length, 0);
  await busy.s.onEvent(idle);
  await busy.s.onEvent(chat("you died"));
  assert.equal(busy.bus.of("brain.say").length, 1);

  const cooling = setup({ cooldown_ms: 60_000, reflexes: [DIED] });
  await cooling.s.onEvent(event("brain.say", { id: "x", text: "hi", emotion: "happy" }));
  await cooling.s.onEvent(idle);
  await cooling.s.onEvent(chat("you died"));
  assert.equal(cooling.bus.of("brain.say").length, 0);

  const muted = setup({ reflexes: [DIED] });
  await muted.s.onEvent(event("control", { cmd: "mute" }));
  await muted.s.onEvent(chat("you died"));
  assert.equal(muted.bus.of("brain.say").length, 0);
});

test("pause: no attention.focus or reflex while paused, intake continues; resume restores; other targets ignored", async () => { // @spec SAL-CTRL-001, SAL-CTRL-002, SAL-CTRL-003, SAL-REFLEX-006
  const { s, bus } = setup({ reflexes: [DIED] });
  await s.onEvent(event("control", { cmd: "pause", target: "voice" })); // not for us
  await s.onEvent(chat("hey Coco?", { mentionsCohost: true }));
  await s.tick();
  assert.equal(bus.of("attention.focus").length, 1);

  bus.clear();
  await s.onEvent(event("control", { cmd: "pause", target: "salience" }));
  await s.onEvent(chat("hey again Coco?", { mentionsCohost: true }));
  await s.onEvent(event("vision.summary", { text: "you died", changed: true }));
  await s.tick();
  assert.equal(bus.published.length, 0, "no focus, no reflex while paused");
  assert.ok(s.ctx.unseen().length > 0, "events were still taken in");

  await s.onEvent(event("control", { cmd: "resume" })); // no target = all
  await s.onEvent(idle);
  await s.tick();
  assert.equal(bus.of("attention.focus").length, 0, "what arrived during the pause is stale (SAL-CTRL-007)");
  await s.onEvent(chat("welcome back Coco?", { mentionsCohost: true }));
  await s.tick();
  assert.equal(bus.of("attention.focus").length, 1);
});

test("a targeted mute for another service does not mute salience", async () => { // @spec SAL-CTRL-001
  const { s, bus } = setup();
  await s.onEvent(event("control", { cmd: "mute", target: "cortex" }));
  await s.onEvent(chat("hey Coco?", { mentionsCohost: true }));
  await s.tick();
  assert.equal(bus.of("attention.focus").length, 1);
});

// ---- test injection

test("tick: an injected focus carries injected/remember onto attention.focus", async () => { // @spec SAL-INJ-001
  const { s, bus } = setup();
  await s.onEvent(chat("hey Coco?", { mentionsCohost: true, injected: true, remember: false }));
  await s.tick();
  const [f] = bus.of("attention.focus");
  assert.equal(f!.injected, true);
  assert.equal(f!.remember, false);
});

test("tick: real focus (even with a stray remember) and no-focus carry neither flag", async () => { // @spec SAL-INJ-002
  const real = setup();
  await real.s.onEvent(chat("hey Coco?", { mentionsCohost: true, remember: true }));
  await real.s.tick();
  const [f] = real.bus.of("attention.focus");
  assert.equal("injected" in f! || "remember" in f!, false);
});

test("tick: a mixed batch follows the focus event, not the others", async () => { // @spec SAL-INJ-003
  const { s, bus } = setup();
  await s.onEvent(chat("hey Coco?", { mentionsCohost: true }));
  await s.onEvent(chat("plain", { injected: true, remember: true }));
  await s.tick();
  const [f] = bus.of("attention.focus");
  assert.equal(f!.focus?.text, "hey Coco?");
  assert.equal("injected" in f!, false);
});

test("reflex: an injected trigger's brain.say carries the flags; a real one carries none", async () => { // @spec SAL-INJ-004
  const inj = setup({ reflexes: [DIED] });
  await inj.s.onEvent(chat("lol you died", { injected: true, remember: false }));
  const [say] = inj.bus.of("brain.say");
  assert.equal(say!.injected, true);
  assert.equal(say!.remember, false);

  const real = setup({ reflexes: [DIED] });
  await real.s.onEvent(chat("lol you died"));
  const [rsay] = real.bus.of("brain.say");
  assert.equal("injected" in rsay! || "remember" in rsay!, false);
});

test("tick: a mute, pause or busy cortex that arrives while the scorer is running stops the focus", async () => { // @spec SAL-FOCUS-005
  const arrives: [string, (s: ReturnType<typeof setup>["s"]) => Promise<void>][] = [
    ["mute", (s) => s.onEvent(event("control", { cmd: "mute" }))],
    ["pause", (s) => s.onEvent(event("control", { cmd: "pause" }))],
    ["busy", (s) => s.onEvent(event("brain.status", { state: "thinking" }))],
  ];
  for (const [name, arrive] of arrives) {
    const { s, bus, setGate } = setup();
    await s.onEvent(chat("hey Coco?", { mentionsCohost: true }));
    let open!: () => void;
    setGate(new Promise<void>((r) => (open = r)));
    const ticking = s.tick();
    await arrive(s);
    open();
    await ticking;
    assert.equal(bus.of("attention.focus").length, 0, `${name}: no focus for a decision made before it`);
  }
});

test("tick: a decision nothing interrupted still publishes after the scorer returns", async () => { // @spec SAL-FOCUS-005
  const { s, bus, setGate } = setup();
  await s.onEvent(chat("hey Coco?", { mentionsCohost: true }));
  let open!: () => void;
  setGate(new Promise<void>((r) => (open = r)));
  const ticking = s.tick();
  open();
  await ticking;
  assert.equal(bus.of("attention.focus").length, 1);
});

test("busy: a thinking cortex stops counting as busy after brain.salience.thinking_timeout_ms", async () => { // @spec SAL-BUSY-001
  let clock = 1_000_000;
  const now = () => clock;
  const advance = (ms: number) => { clock += ms; };
  {
    const short = setup({ thinking_timeout_ms: 5_000 }, {}, now);
    await short.s.onEvent(event("brain.status", { state: "thinking" }));
    await short.s.onEvent(chat("hey Coco?", { mentionsCohost: true }));
    advance(4_999);
    await short.s.tick();
    assert.equal(short.bus.of("attention.focus").length, 0, "still inside the configured valve");
    advance(2);
    await short.s.tick();
    assert.equal(short.bus.of("attention.focus").length, 1, "past the configured valve, not the old 60 s literal");

    const dflt = setup({}, {}, now);
    await dflt.s.onEvent(event("brain.status", { state: "thinking" }));
    await dflt.s.onEvent(chat("hey Coco?", { mentionsCohost: true }));
    advance(59_000);
    await dflt.s.tick();
    assert.equal(dflt.bus.of("attention.focus").length, 0, "default valve is 60 s");
    advance(2_000);
    await dflt.s.tick();
    assert.equal(dflt.bus.of("attention.focus").length, 1);
  }
});

test("reflex: publishing starts the cooldown and marks the voice speaking before the echo returns", async () => { // @spec SAL-REFLEX-007
  const two = [DIED, { match: "level up", say: ["Nice."], emotion: "happy", cooldown_ms: 0 }];
  const { s, bus } = setup({ cooldown_ms: 60_000, reflexes: two });
  await s.onEvent(chat("you died"));
  assert.equal(bus.of("brain.say").length, 1);
  // No brain.say echo has been delivered to s. A second rule and a tick must still be held back.
  await s.onEvent(chat("level up"));
  assert.equal(bus.of("brain.say").length, 1, "second reflex waits out the cooldown");
  await s.onEvent(chat("hey Coco?", { mentionsCohost: true }));
  await s.tick();
  assert.equal(bus.of("attention.focus").length, 0, "no tick fires inside the reflex's cooldown");
});

test("reflex: with a zero cooldown a reflex still marks the voice speaking, so the next tick waits", async () => { // @spec SAL-REFLEX-007
  const { s, bus } = setup({ reflexes: [DIED] });
  await s.onEvent(chat("you died"));
  await s.onEvent(chat("hey Coco?", { mentionsCohost: true }));
  await s.tick();
  assert.equal(bus.of("attention.focus").length, 0, "cortex state is speaking until the voice reports done");
});

test("decide: reason is mentioned only when the focus is a mention and reply_on_mention is on", async () => { // @spec SAL-DECIDE-008
  const on = setup();
  await on.s.onEvent(chat("hey Coco", { mentionsCohost: true }));
  await on.s.tick();
  assert.equal(on.bus.of("attention.focus")[0]!.reason, "mentioned");

  const off = setup({ reply_on_mention: false, speak_threshold: 0.1 });
  await off.s.onEvent(chat("hey Coco", { mentionsCohost: true }));
  await off.s.tick();
  assert.equal(off.bus.of("attention.focus")[0]!.reason, "engaged");
});

test("tick: a failed attention.focus publish is logged and the next tick still runs", async () => { // @spec SAL-HEALTH-002
  const cfg = testConfig({ brain: { salience: { cooldown_ms: 0, idle_chatter_ms: 0 } } });
  const bus = new FakeBus();
  const rec = recordingLog();
  const scorer = new Module<ScoreInput, ScoreOutput>("s", ModuleSchema.parse({}), cfg.llm, { rules: (i) => scoreRules(i, true) }, silentLog);
  const s = new Salience({ cfg, bus, scorer, log: rec.log });
  bus.fail = (t) => t === "attention.focus";
  await s.onEvent(chat("hey Coco?", { mentionsCohost: true }));
  await assert.doesNotReject(s.tick());
  assert.equal(rec.msgs("error").length, 1);
  assert.match(String(rec.msgs("error")[0]), /tick/);

  bus.fail = undefined;
  await s.tick(); // no idle event: the failed publish rolled back the busy state and left the events unseen
  assert.equal(bus.of("attention.focus").length, 1, "the next tick retried and published");
});

// Streamed lines (SAL-BUSY-005..008): playback events of the cortex's own line renew the speaking valve. Fake monotonic clock.
function streamed(valve = 100) {
  let t = 1_000_000;
  const h = setup({ cooldown_ms: 0, idle_chatter_ms: 0 }, { brain: { salience: { cooldown_ms: 0, idle_chatter_ms: 0 }, cortex: { speaking_timeout_ms: valve } } }, () => t);
  const mention = chat("hey Coco?", { mentionsCohost: true });
  return { ...h, advance: (ms: number) => { t += ms; }, mention };
}
const cortexSay = (id: string, more = true) => event("brain.say", { id, text: "one", emotion: "happy", reason: "speech", ...(more ? { more: true as const } : {}) });
const playing = (id: string, seq = 0, sink = "discord") => event("voice.playing", { id, seq, sink });
const done = (id: string, seq = 0, sink = "discord") => event("voice.done", { id, seq, sink });

// @spec SAL-BUSY-006, SAL-BUSY-002
test("busy: a voice.playing or voice.done of the cortex line with more restarts the speaking age, from any sink", async () => {
  for (const sink of ["discord", "dryrun", "virtual"]) {
    for (const ev of [playing("L", 1, sink), done("L", 1, sink)]) {
      const { s, bus, advance, mention } = streamed();
      await s.onEvent(cortexSay("L"));
      advance(80);
      await s.onEvent(ev); // 80 ms in, valve 100: renewed
      advance(80); // 160 ms from the say, 80 from the renewal
      await s.onEvent(mention);
      await s.tick();
      assert.equal(bus.of("attention.focus").length, 0, `still busy after ${ev.type} on ${sink}`);
      advance(30); // 110 ms from the renewal: valve over
      await s.tick();
      assert.equal(bus.of("attention.focus").length, 1, "free once the renewed valve ran out");
    }
  }
});

// @spec SAL-BUSY-006, SAL-BUSY-002
test("busy: renewal repeats, so a long streamed line stays busy for as long as its clauses play", async () => {
  const { s, bus, advance, mention } = streamed();
  await s.onEvent(cortexSay("L"));
  for (let seq = 0; seq < 6; seq++) { advance(70); await s.onEvent(playing("L", seq)); await s.onEvent(done("L", seq)); }
  await s.onEvent(mention);
  await s.tick();
  assert.equal(bus.of("attention.focus").length, 0, "420 ms in, valve 100: busy");
});

// @spec SAL-BUSY-007
test("busy: playback events of another line, of a line without more, or while the state is not speaking do not renew", async () => {
  { // another line
    const { s, bus, advance, mention } = streamed();
    await s.onEvent(cortexSay("L"));
    advance(80);
    await s.onEvent(playing("other", 1));
    await s.onEvent(done("other", 1));
    advance(30);
    await s.onEvent(mention);
    await s.tick();
    assert.equal(bus.of("attention.focus").length, 1, "valve ran out from the say");
  }
  { // a line without more keeps the 20 s valve from when the state was set
    const { s, bus, advance, mention } = streamed();
    await s.onEvent(cortexSay("L", false));
    advance(80);
    await s.onEvent(playing("L", 0));
    await s.onEvent(done("L", 0));
    advance(30);
    await s.onEvent(mention);
    await s.tick();
    assert.equal(bus.of("attention.focus").length, 1);
  }
  { // not speaking: idle after a status, a playback event must not make it busy again
    const { s, bus, advance, mention } = streamed();
    await s.onEvent(cortexSay("L"));
    await s.onEvent(idle);
    await s.onEvent(playing("L", 1));
    await s.onEvent(done("L", 1));
    advance(10);
    await s.onEvent(mention);
    await s.tick();
    assert.equal(bus.of("attention.focus").length, 1, "idle stays idle");
  }
});

// @spec SAL-BUSY-005, SAL-BUSY-006
test("busy: an operator say does not replace the remembered cortex line, so its playback events still renew", async () => {
  const { s, bus, advance, mention } = streamed();
  await s.onEvent(cortexSay("L"));
  await s.onEvent(event("brain.say", { id: "op", text: "hello", emotion: "neutral", reason: "operator" }));
  advance(80);
  await s.onEvent(playing("L", 1));
  advance(80);
  await s.onEvent(mention);
  await s.tick();
  assert.equal(bus.of("attention.focus").length, 0, "L's event renewed the state although op set it last");
});

// @spec SAL-BUSY-005, SAL-BUSY-007
test("busy: a playback event of a reflex or operator line does not renew", async () => {
  for (const [id, reason] of [["rx", "reflex: you died"], ["op", "operator"]] as const) {
    const { s, bus, advance, mention } = streamed();
    await s.onEvent(cortexSay("L"));
    await s.onEvent(event("brain.say", { id, text: "x", emotion: "neutral", reason, more: true }));
    advance(80);
    await s.onEvent(playing(id, 0));
    advance(30);
    await s.onEvent(mention);
    await s.tick();
    assert.equal(bus.of("attention.focus").length, 1, `${reason}: no renewal`);
  }
});

// @spec SAL-BUSY-008
test("cooldown and idle-chatter timer are measured from the brain.say only: playback events restart neither", async () => {
  let t = 1_000_000;
  const h = setup({ cooldown_ms: 100, idle_chatter_ms: 0 }, {}, () => t);
  await h.s.onEvent(cortexSay("L"));
  t += 80;
  await h.s.onEvent(playing("L", 1));
  await h.s.onEvent(done("L", 1));
  t += 30; // 110 ms from the say, 30 from the events
  await h.s.onEvent(idle);
  await h.s.onEvent(chat("hey Coco?", { mentionsCohost: true }));
  await h.s.tick();
  assert.equal(h.bus.of("attention.focus").length, 1, "cooldown over: it ran from the say");
});

// @spec SAL-BUSY-005, SAL-BUSY-006
test("busy: a later cortex line without more replaces the remembered line, so the earlier line's playback no longer renews", async () => {
  const { s, bus, advance, mention } = streamed();
  await s.onEvent(cortexSay("L"));
  await s.onEvent(cortexSay("M", false));
  advance(80);
  await s.onEvent(playing("L", 1)); // L is no longer the cortex's line
  advance(30); // 110 ms from the say of M, valve 100
  await s.onEvent(mention);
  await s.tick();
  assert.equal(bus.of("attention.focus").length, 1, "L's playback did not renew the speaking state");
});

// @spec SAL-BUSY-005
test("busy: a brain.say with no reason counts as the cortex line, so its playback renews", async () => {
  const { s, bus, advance, mention } = streamed();
  await s.onEvent(event("brain.say", { id: "L", text: "one", emotion: "happy", more: true }));
  advance(80);
  await s.onEvent(playing("L", 1));
  advance(80); // 160 ms from the say, 80 from the renewal
  await s.onEvent(mention);
  await s.tick();
  assert.equal(bus.of("attention.focus").length, 0, "still busy: the reasonless say was remembered as the cortex line");
});

// @spec SAL-BUSY-008
test("idle chatter: playback events restart neither the idle timer nor the cooldown, which run from the brain.say", async () => {
  let t = 1_000_000;
  const h = setup({ cooldown_ms: 0, idle_chatter_ms: 100 }, { brain: { salience: { cooldown_ms: 0, idle_chatter_ms: 100 }, cortex: { speaking_timeout_ms: 20 } } }, () => t);
  await h.s.onEvent(chat("plain")); // an unseen event below the threshold; the scorer's idle timer runs from the last activity
  t += 5;
  await h.s.onEvent(cortexSay("L")); // the say starts the idle timer and the cooldown
  t += 80;
  await h.s.onEvent(playing("L", 1)); // renews the speaking state (valve 20: not busy at 110 ms) but not the idle timer
  await h.s.onEvent(done("L", 1));
  t += 25; // 105 ms since the say, 25 since the playback events
  await h.s.tick();
  assert.equal(h.bus.of("attention.focus").length, 1, "idle chatter fired: the idle timer ran from the say");
  assert.equal(h.bus.of("attention.focus")[0]!.reason, "idle chatter");
});
