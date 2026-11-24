import { test } from "node:test";
import assert from "node:assert/strict";
import { event, waitFor } from "@cohost/testing";
import {
  EARLY, FINAL, J, call, chatFocus, confirm, control, endOther, gate, opened, ordinary, other, provisional, setup, sleep, streamed, systemMsg,
  userMsg, withdraw, type S,
} from "./provisional.fixture.js";

// A provisional think (cortex-design.md, Provisional think; CTX-PROV-001 to 038): the cortex prepares a reply on a provisional
// `attention.focus` and releases it as an ordinary reply only on a confirm. Every test drives the cortex through `onEvent`, as
// main.ts does, over a scripted model.

const MULTI = "[happy] First clause is here, second clause follows, and a third to end.";
/**
 * The hold limit used by these tests. It is long enough that the assertions made before it fire are not raced by the timer under load,
 * and every test waits for the limit with a bounded wait, so the limit's own effect is what is checked.
 */
const LIMIT = 1000;
const withoutIds = (events: unknown[]) => J(events).map((e: Record<string, unknown>) => { const { id: _id, ...rest } = e; return rest; });

/** Starts a provisional think over `text` and waits until the model has been read to its end. */
async function hold(s: S, text = MULTI, focus = provisional()): Promise<void> {
  s.llm.rounds.push({ text });
  await s.cortex.onEvent(focus);
  await streamed(s);
}
/** Starts a provisional think whose model stream stays open after its text, so an end must abort it; returns the function that lets it finish. */
async function holdOpen(s: S, text = MULTI): Promise<() => void> {
  const g = gate();
  s.llm.rounds.push({ text, hold: g.promise });
  await s.cortex.onEvent(provisional());
  await opened(s);
  await sleep(20);
  return g.open;
}

// ---- start, and what a provisional think withholds (CTX-PROV-001 to 004) ----

// @spec CTX-PROV-001
test("a provisional focus starts a think: brain.status thinking with the reason as detail and one model call", async () => {
  const s = setup();
  s.llm.rounds.push({ text: MULTI });
  await s.cortex.onEvent(provisional({ reason: "engaged" }));
  await waitFor(() => s.llm.calls.length === 1, "model call");
  assert.deepEqual(s.statuses(), ["thinking"]);
  assert.equal(s.bus.of("brain.status")[0]!.detail, "engaged");
});

// @spec CTX-PROV-001
test("a provisional focus goes through the gates: muted publishes muted and busy publishes speaking, with no model call", async () => {
  const muted = setup();
  await muted.cortex.onEvent(control("mute"));
  await muted.cortex.onEvent(provisional());
  await sleep(40);
  assert.equal(muted.llm.calls.length, 0);
  assert.equal(muted.statuses().at(-1), "muted");

  const busy = setup();
  await other(busy);
  await busy.cortex.onEvent(provisional());
  await sleep(40);
  assert.equal(busy.llm.calls.length, 0);
  assert.equal(busy.statuses().at(-1), "speaking");
});

// @spec CTX-PROV-002
test("a provisional think publishes the recall and notes requests an ordinary think of the same focus publishes", async () => {
  const ordinaryRun = setup({ recallK: 3 });
  await ordinaryRun.cortex.think({ reason: "mentioned", score: 1, focus: { kind: "speech", who: "Chris", text: EARLY, mention: false } });
  const want = ordinaryRun.types().filter((t) => t === "memory.recall.request" || t === "memory.notes.request");
  assert.ok(want.includes("memory.recall.request"), "the ordinary think asks for a recall");

  const s = setup({ recallK: 3 });
  s.llm.rounds.push({ text: MULTI });
  await s.cortex.onEvent(provisional());
  await streamed(s);
  assert.deepEqual(s.types().filter((t) => t === "memory.recall.request" || t === "memory.notes.request"), want);
});

// @spec CTX-PROV-003
test("until the confirmation a provisional think publishes no brain.say, no brain.clause, no tool.request and no voice.stop", async () => {
  const s = setup({ withTool: true });
  s.llm.rounds.push({ text: MULTI });
  await s.cortex.onEvent(provisional());
  await streamed(s);
  await sleep(60);
  assert.deepEqual(s.types().filter((t) => !["brain.status", "memory.recall.request", "memory.notes.request"].includes(t)), []);
  await s.cortex.onEvent(control("pause"));
  assert.equal(s.types().includes("voice.stop"), false, "a pause ends the held think and stops no line of its own");
});

// @spec CTX-PROV-004
test("until the confirmation a provisional think deletes no viewer note, consumes no glitch and adds no self entry", async () => {
  const s = setup();
  // A pending glitch: a fallback played in place of a line of salience's.
  await s.cortex.onEvent(event("brain.say", { id: "a", text: "intended line", emotion: "happy", reason: "r" }, "salience"));
  await s.cortex.onEvent(event("voice.failed", { id: "a", seq: 0, sink: "discord", reason: "tts down", fallback: { clip: "c1", text: "my mic died" } }));
  await endOther(s, "a");
  // A viewer note for the chat viewer the provisional focus is on.
  await s.cortex.onEvent(event("memory.viewer", { platform: "twitch", user: "bob", isNew: true, msgCount: 1, regular: false }));
  const selfBefore = s.cortex.ctx.all().filter((e) => e.kind === "self").length;
  s.llm.rounds.push({ text: MULTI });
  await s.cortex.onEvent(event("attention.focus", { reason: "engaged", score: 1, provisional: true, utteranceId: "u1", seq: 0, focus: { kind: "chat", who: "bob", platform: "twitch", text: "hello there Coco", mention: false } }, "salience"));
  await streamed(s);
  assert.equal(s.cortex.ctx.all().filter((e) => e.kind === "self").length, selfBefore, "no self entry");
  // The held think is withdrawn; the note and the glitch are still pending for the next reply.
  await s.cortex.onEvent(withdraw());
  s.llm.rounds.push({ text: "[happy] Hello Bob, welcome in." });
  await s.cortex.think({ reason: "engaged", score: 1, focus: { kind: "chat", who: "bob", platform: "twitch", text: "hello there Coco", mention: false } });
  assert.match(systemMsg(s, 1), /- bob is new here \(first message\)\./);
  assert.match(systemMsg(s, 1), /Your voice glitched/);
});

// ---- the prompt (CTX-PROV-005) ----

// @spec CTX-PROV-005
test("the prompt is built once from the window at the start plus the early text as a last [voice] line, outside the window", async () => {
  const s = setup();
  await s.cortex.onEvent(event("chat.message", { platform: "twitch", user: "amy", text: "before the hold", id: "c0" } as never));
  s.llm.rounds.push({ text: MULTI, hold: undefined });
  const g = gate();
  s.llm.rounds[0]!.hold = g.promise;
  await s.cortex.onEvent(provisional());
  await opened(s);
  await s.cortex.onEvent(event("chat.message", { platform: "twitch", user: "zed", text: "during the hold", id: "c1" } as never));
  g.open();
  await streamed(s);
  const transcript = userMsg(s).split("## Recent transcript\n")[1]!.split("\n\n")[0]!.split("\n");
  assert.match(transcript.at(-1)!, new RegExp(`^\\[voice\\] Chris: ${EARLY}$`), "the early text is the last transcript line");
  assert.ok(transcript.some((l) => l.includes("before the hold")), "the window at the start is in the prompt");
  assert.ok(!userMsg(s).includes("during the hold"), "events that reach the window during the hold are not");
  assert.equal(s.llm.calls.length, 1, "never rebuilt: one model call");
  assert.ok(s.cortex.ctx.all().some((e) => e.kind === "chat" && e.text === "during the hold"), "the later chat is in the window");
  assert.ok(!s.cortex.ctx.all().some((e) => e.kind === "speech"), "the early text is not in the window");
});

// ---- holding clauses (CTX-PROV-006 to 009, 030, 036 to 038) ----

// @spec CTX-PROV-006, CTX-PROV-038
test("clauses are held in order and the model is read to its end; a confirm publishes the first as brain.say and the rest as brain.clause", async () => {
  const s = setup();
  await hold(s);
  assert.equal(s.says().length + s.clauses().length, 0);
  assert.equal(s.llm.endedAborted[0], false, "the stream was read to its end");
  await s.cortex.onEvent(confirm());
  await waitFor(() => s.clauses().some((c) => c.last), "closing clause");
  assert.deepEqual(s.line().map((e) => [e.seq ?? null, e.text, e.last ?? null]), [
    [null, "First clause is here,", null], [1, "second clause follows,", null], [2, "and a third to end.", true],
  ]);
  assert.equal(s.says()[0]!.more, true);
});

// @spec CTX-PROV-006, CTX-PROV-038
test("a released reply is the reply an ordinary think of the same model text publishes, for one clause, several and max_clauses", async () => {
  const shapes: { text: string; cortex?: Record<string, unknown> }[] = [
    { text: "[happy] Just one short line here." },
    { text: MULTI },
    { text: "[happy] One clause here, two clause here, three clause here, four clause here, five clause here.", cortex: { max_clauses: 2 } },
  ];
  for (const shape of shapes) {
    const ord = setup({ cortex: shape.cortex });
    ord.llm.rounds.push({ text: shape.text });
    await ord.cortex.think({ reason: "mentioned", score: 1, focus: { kind: "speech", who: "Chris", text: FINAL_TEXT, mention: false } });
    const prov = setup({ cortex: shape.cortex });
    await hold(prov, shape.text);
    await prov.cortex.onEvent(confirm());
    await waitFor(() => prov.says().length === 1, "released say");
    await sleep(30);
    // The reply's shape: text, clause order, closing clause, cut, emotion, gesture and reason; only the stamps and ids differ by design (CTX-PROV-025).
    type Shaped = { text: string; seq?: number; last?: true; through?: number; cut?: string; more?: true; emotion?: string; gesture?: string; reason?: string };
    const shapeOf = (events: Shaped[]) =>
      events.map((e) => ({ text: e.text, seq: e.seq ?? null, last: e.last ?? null, through: e.through ?? null, cut: e.cut ?? null, more: e.more ?? null, emotion: e.emotion ?? null, gesture: e.gesture ?? null, reason: e.reason ?? null }));
    assert.deepEqual(shapeOf(prov.line() as never), shapeOf(ord.line() as never), shape.text);
  }
});
const FINAL_TEXT = "hey Coco what time is it?";

// @spec CTX-PROV-007
test("with an llm critic the whole reply is collected, criticised once and held whole", async () => {
  const s = setup({ kind: "llm" });
  const g = gate();
  s.llm.rounds.push({ text: MULTI, hold: g.promise });
  await s.cortex.onEvent(provisional());
  await opened(s);
  assert.equal(s.criticCalls.length, 0, "no critic call while the stream is open");
  g.open();
  await streamed(s);
  assert.equal(s.criticCalls.length, 1);
  assert.match(s.criticCalls[0]!.text, /First clause is here.*second clause follows.*third to end/);
  assert.equal(s.says().length, 0);
  await s.cortex.onEvent(confirm());
  await waitFor(() => s.says().length === 1, "released say");
});

// @spec CTX-PROV-008, CTX-PROV-022
test("a vetoed, empty or repeated first-clause result is held as no line and a confirm takes the no-line exit: idle, nothing spoken", async () => {
  const veto = setup({ critic: () => ({ ok: false, note: "no" }) });
  const repeat = setup();
  // A recent line of hers the reply repeats.
  await repeat.cortex.onEvent(event("brain.say", { id: "r", text: "First clause is here,", emotion: "happy" }, "cortex"));
  const empty = setup();
  for (const [name, s, text] of [["veto", veto, MULTI], ["repeat", repeat, MULTI], ["empty", empty, ""]] as const) {
    const before = s.says().length;
    await hold(s, text);
    assert.deepEqual(s.statuses().filter((x) => x !== "thinking"), [], `${name}: no status but thinking during the hold`);
    await s.cortex.onEvent(confirm());
    await waitFor(() => s.statuses().at(-1) === "idle", `${name}: idle`);
    assert.equal(s.says().length, before, `${name}: nothing spoken`);
    assert.equal(s.clauses().length, 0, name);
  }
});

// @spec CTX-PROV-009, CTX-PROV-030
test("a tool call parks the think: the text before it is held, no tool.request until the confirm, and heldAt is stamped at the park", async () => {
  const s = setup({ withTool: true });
  s.llm.rounds.push({ text: "[happy] Let me check the clock.", calls: [call("c1")] }, { text: "[happy] It is noon." });
  s.bus.answerAfterMs = 5;
  const t0 = Date.now();
  await s.cortex.onEvent(provisional());
  await streamed(s);
  await sleep(60);
  assert.equal(s.bus.requests.length, 0, "no tool.request while held");
  assert.equal(s.llm.calls.length, 1, "the loop waits at the call");
  assert.equal(s.says().length, 0);
  const before = Date.now();
  await s.cortex.onEvent(confirm());
  await waitFor(() => s.line().some((e) => e.text === "It is noon."), "the second round is spoken");
  assert.equal(s.bus.requests.length, 1, "the request goes out after the confirm");
  assert.ok(s.bus.reqAt[0]! >= before, "tool.request is published after the confirmation");
  const say = s.says()[0]!;
  assert.equal(say.text, "Let me check the clock.");
  assert.ok(say.timing!.heldAt! >= t0 && say.timing!.heldAt! <= before, JSON.stringify(say.timing));
});

// @spec CTX-PROV-009
test("the call budget counts from the first tool.request after the confirmation, not from the park", async () => {
  // The hold outlasts the 400 ms budget, so a budget that counted from the park would be spent before the confirm. The answer
  // comes in a few ms, well inside it, and the filler is out of reach (60 s) so only the budget is under test.
  const s = setup({ withTool: true, tools: { reply: { filler_after_ms: 60_000, budget_ms: 400, filler_lines: ["Hold on a sec."] } } });
  s.llm.rounds.push({ text: "[happy] Let me check the clock.", calls: [call("c1")] }, { text: "[happy] It is noon." });
  s.bus.answerAfterMs = 5;
  await s.cortex.onEvent(provisional());
  await streamed(s);
  await sleep(500); // longer than the budget
  assert.equal(s.bus.requests.length, 0, "no tool.request during the hold");
  assert.equal(s.says().length, 0, "no line during the hold");
  await s.cortex.onEvent(confirm());
  await waitFor(() => s.line().some((e) => e.text === "It is noon."), "the second round is spoken");
  assert.equal(s.bus.requests.length, 1, "the request went out after the confirm: the budget was not spent during the hold");
  assert.ok(!s.line().some((e) => e.text === "Sorry, I couldn't find that out."), "no give-up line");
});

// @spec CTX-PROV-009
test("the filler clock counts from the first tool.request after the confirmation, not from the park", async () => {
  // The hold outlasts the 100 ms filler clock. A clock counted from the park would have fired at the confirm, before the request
  // went out; so the filler must be observed no earlier than 100 ms after the confirm that released the request.
  const s = setup({ withTool: true, tools: { reply: { filler_after_ms: 100, budget_ms: 60_000, filler_lines: ["Hold on a sec."] } } });
  s.llm.rounds.push({ calls: [call("c1")] }, { text: "[happy] It is noon." });
  s.bus.answerAfterMs = 300;
  await s.cortex.onEvent(provisional());
  await streamed(s);
  await sleep(150); // longer than the filler clock
  assert.equal(s.bus.requests.length, 0, "no tool.request during the hold");
  const confirmAt = Date.now();
  await s.cortex.onEvent(confirm());
  let fillerAt: number | undefined;
  await waitFor(() => {
    if (fillerAt === undefined && s.line().some((e) => e.text === "Hold on a sec.")) fillerAt = Date.now();
    return fillerAt !== undefined;
  }, "the filler is spoken", 2000);
  assert.equal(s.bus.requests.length, 1, "the request went out after the confirm");
  // Measured from the confirm, which precedes the request, so no slack is needed for the request's publish; 1 ms covers timer rounding.
  assert.ok(fillerAt! >= confirmAt + 99, `filler observed ${fillerAt! - confirmAt} ms after the confirm, want at least 100`);
  await waitFor(() => s.line().some((e) => e.text === "It is noon."), "the second round is spoken", 2000);
});

// @spec CTX-PROV-025, CTX-PROV-019, CTX-PROV-030, CTX-SAY-006
test("a confirm releases with the think's own stamps, focusedAt of the provisional focus, confirmedAt, heldAt and the final's timing", async () => {
  const s = setup();
  const focus = provisional();
  await s.cortex.onEvent(focus);
  await streamed(s);
  await sleep(30);
  const before = Date.now();
  await s.cortex.onEvent(confirm());
  const after = Date.now();
  await waitFor(() => s.says().length === 1, "released say");
  const t = s.says()[0]!.timing!;
  assert.equal(t.focusedAt, focus.ts, "focusedAt is the provisional focus envelope ts");
  assert.deepEqual([t.audioEndedAt, t.closedAt, t.heardAt], [150, 140, 160], "the final's members, not the provisional focus's");
  assert.ok(t.confirmedAt! >= before && t.confirmedAt! <= after, `confirmedAt ${t.confirmedAt} in ${before}..${after}`);
  assert.ok(t.llmStartedAt! >= focus.ts && t.llmStartedAt! <= t.llmEndedAt! && t.llmEndedAt! <= t.criticEndedAt!, JSON.stringify(t));
  assert.ok(t.criticEndedAt! <= before, "the think's own stamps are from before the confirmation");
  assert.ok(t.heldAt! >= t.llmEndedAt! && t.heldAt! <= before, "heldAt is when the reply became ready");
  assert.equal(s.says()[0]!.interjected, undefined);
});

// @spec CTX-PROV-030, CTX-PROV-021
test("heldAt is the first clause being held, and a confirm while the stream is still open publishes at once and carries on as an ordinary think", async () => {
  const s = setup();
  const g = gate();
  s.llm.rounds.push({ text: MULTI, hold: g.promise });
  await s.cortex.onEvent(provisional());
  await opened(s);
  await sleep(40);
  await s.cortex.onEvent(confirm());
  await waitFor(() => s.says().length === 1, "say before the stream ends");
  assert.equal(s.says()[0]!.more, true, "the stream is still open, so more clauses may follow");
  const heldAt = s.says()[0]!.timing!.heldAt;
  assert.ok(heldAt !== undefined, "heldAt before the stream ended");
  assert.equal(s.llm.ended[0], undefined, "reading continues after the stamp");
  g.open();
  await waitFor(() => s.clauses().some((c) => c.last), "closing clause");
  assert.deepEqual(s.line().map((e) => e.text), ["First clause is here,", "second clause follows,", "and a third to end.", ""].slice(0, s.line().length));
  assert.equal(s.llm.calls.length, 1);
});

// @spec CTX-PROV-036
test("a confirm that finds a line of someone else pending drops the think: no brain.say, status speaking, and no thinking after it", async () => {
  const s = setup();
  await hold(s);
  await other(s); // a reflex line begins during the hold
  const thinkingBefore = s.statuses().filter((x) => x === "thinking").length;
  await s.cortex.onEvent(confirm());
  await waitFor(() => s.statuses().at(-1) === "speaking", "speaking");
  assert.equal(s.statuses().filter((x) => x === "thinking").length, thinkingBefore);
  assert.equal(s.says().length, 0);
  assert.equal(s.clauses().length, 0);
});

// @spec CTX-PROV-037, CTX-PROV-038
test("a released think publishes brain.status thinking, then brain.say, then the held clauses", async () => {
  const s = setup();
  await hold(s);
  const n = s.bus.published.length;
  await s.cortex.onEvent(confirm({ reason: "engaged" }));
  await waitFor(() => s.clauses().some((c) => c.last), "closing clause");
  const after = s.bus.published.slice(n).filter((p) => p.type === "brain.status" || p.type === "brain.say" || p.type === "brain.clause").map((p) => p.type);
  assert.equal(after[0], "brain.status");
  assert.equal((s.bus.published[n]!.data as { state: string }).state, "thinking");
  // CTX-STREAM-018: the released reply is an ordinary one, so the first clause's `speaking` status follows its brain.say.
  assert.deepEqual(after.slice(1), ["brain.say", "brain.status", "brain.clause", "brain.clause"]);
});

// ---- the hold limit (CTX-PROV-010, 014, 029, 035) ----

// @spec CTX-PROV-010, CTX-PROV-014, CTX-PROV-016, CTX-PROV-029, CTX-PROV-031, CTX-PROV-032
test("the hold limit counts from the start of the think: it aborts the stream even before a clause is ready, publishes idle and frees the cortex", async () => {
  // Long enough that the stream is still open when the test looks, even under load; the limit then ends it.
  const s = setup({ cortex: { hold_limit_ms: LIMIT } });
  const g = gate();
  s.llm.rounds.push({ text: MULTI, gate: g.promise });
  await s.cortex.onEvent(provisional());
  await opened(s);
  assert.equal(s.llm.ended[0], undefined);
  await waitFor(() => s.statuses().at(-1) === "idle", "idle at the limit");
  g.open();
  await waitFor(() => s.llm.ended[0] === true, "stream ended");
  assert.equal(s.llm.endedAborted[0], true, "the stream was aborted through the think's signal");
  assert.equal(s.says().length + s.clauses().length, 0);
  // The thinking flag is clear: an ordinary focus is thought on, not declined.
  s.llm.rounds.push({ text: "[happy] Hello again, Chris." });
  await s.cortex.onEvent(ordinary({ utteranceId: "u9", focus: { kind: "speech", who: "Chris", text: "another sentence", mention: false } }));
  await waitFor(() => s.says().length === 1, "ordinary think speaks");
});

// @spec CTX-PROV-014, CTX-PROV-033
test("when the hold limit ends a think while a line of someone else is pending, the status is speaking", async () => {
  const s = setup({ cortex: { hold_limit_ms: LIMIT } });
  s.llm.rounds.push({ text: MULTI });
  await s.cortex.onEvent(provisional());
  await streamed(s);
  await other(s);
  await waitFor(() => s.statuses().at(-1) === "speaking", "speaking at the limit");
  assert.ok(!s.statuses().includes("idle"));
  assert.equal(s.says().length + s.clauses().length, 0, "held, never published");
  assert.equal(s.statuses().filter((x) => x === "thinking").length, 1);
});

// @spec CTX-PROV-014, CTX-PROV-023
test("a confirm that arrives after the limit ended the think is an ordinary focus", async () => {
  const s = setup({ cortex: { hold_limit_ms: LIMIT } });
  await hold(s);
  await waitFor(() => s.statuses().at(-1) === "idle", "limit");
  s.llm.rounds.push({ text: "[happy] Half past noon, I think." });
  await s.cortex.onEvent(confirm());
  await waitFor(() => s.says().length === 1, "an ordinary reply");
  assert.equal(s.llm.calls.length, 2, "a new model call");
  assert.equal(s.says()[0]!.timing!.confirmedAt, undefined);
});

// @spec CTX-PROV-035, CTX-PROV-021
test("a release clears the hold limit: a confirmed think still reading the stream is not ended by it", async () => {
  const s = setup({ cortex: { hold_limit_ms: LIMIT } });
  const g = gate();
  s.llm.rounds.push({ text: MULTI, hold: g.promise });
  await s.cortex.onEvent(provisional());
  await opened(s);
  assert.equal(s.says().length, 0, "held until the confirm");
  await s.cortex.onEvent(confirm());
  await waitFor(() => s.says().length === 1, "released say");
  assert.equal(s.llm.calls.length, 1, "the released think is the one model call");
  await sleep(LIMIT + 150); // past the limit, which the release cleared
  assert.equal(s.llm.ended[0], undefined, "the stream is still open");
  assert.equal(s.statuses().filter((x) => x === "idle").length, 0, "the limit did not end the released think");
  g.open();
  await waitFor(() => s.clauses().some((c) => c.last), "closing clause");
  assert.equal(s.llm.endedAborted[0], false);
});

// ---- the end triggers (CTX-PROV-011 to 016, 027, 031 to 034) ----

/** Asserts the think was ended without a line: aborted, nothing published, nothing owed, and the cortex is free. */
async function assertEnded(s: S, status: string): Promise<void> {
  await waitFor(() => s.llm.ended[0] === true, "stream ended");
  assert.equal(s.llm.endedAborted[0], true, "aborted through the think's signal");
  assert.equal(s.says().length + s.clauses().length, 0, "no line, no closing clause");
  assert.equal(s.statuses().at(-1), status);
}

// @spec CTX-PROV-011, CTX-PROV-016, CTX-PROV-031, CTX-PROV-032, CTX-PROV-033
test("a withdraw for the held utterance and seq ends the think: stream aborted, held clauses dropped, status idle, and the cortex is free", async () => {
  const s = setup();
  const g = gate();
  s.llm.rounds.push({ text: MULTI, hold: g.promise }); // still reading when withdrawn
  await s.cortex.onEvent(provisional());
  await opened(s);
  await s.cortex.onEvent(withdraw());
  await assertEnded(s, "idle");
  s.llm.rounds.push({ text: "[happy] Hello again, Chris." });
  await s.cortex.onEvent(ordinary({ utteranceId: "u9", focus: { kind: "speech", who: "Chris", text: "another sentence", mention: false } }));
  await waitFor(() => s.says().length === 1, "free for an ordinary think");
});

// @spec CTX-PROV-024
test("a withdraw with no think held changes nothing", async () => {
  const none = setup();
  await none.cortex.onEvent(withdraw());
  await sleep(30);
  assert.deepEqual(none.bus.published, []);
  assert.equal(none.llm.calls.length, 0);
});

// @spec CTX-PROV-011, CTX-PROV-023, CTX-PROV-024
test("a withdraw for another utterance or seq ends the held think as a replacement: no idle, and a later confirm is an ordinary focus", async () => {
  for (const mismatch of [{ utteranceId: "u2" }, { seq: 1 }]) {
    const s = setup();
    await hold(s);
    await s.cortex.onEvent(withdraw("resumed", mismatch));
    await sleep(30);
    assert.deepEqual(s.statuses(), ["thinking"], JSON.stringify(mismatch));
    assert.equal(s.says().length + s.clauses().length, 0, JSON.stringify(mismatch));
    // Nothing is held now, so the confirm of the held utterance is an ordinary focus with a model call of its own.
    s.llm.rounds.push({ text: "[happy] Half past noon, I think." });
    await s.cortex.onEvent(confirm());
    await waitFor(() => s.says().length === 1, "an ordinary reply");
    assert.equal(s.llm.calls.length, 2, JSON.stringify(mismatch));
    assert.equal(s.says()[0]!.timing!.confirmedAt, undefined);
  }
});

// @spec CTX-PROV-015, CTX-PROV-023, CTX-PROV-034
test("a confirm for another utterance ends the held think as a replacement, then is taken as an ordinary focus", async () => {
  const s = setup();
  await holdOpen(s);
  s.llm.rounds.push({ text: "[happy] Half past noon, I think." });
  await s.cortex.onEvent(confirm({ utteranceId: "u2", seq: 0 }));
  await waitFor(() => s.says().length === 1, "an ordinary reply");
  assert.equal(s.llm.endedAborted[0], true, "the held stream was aborted");
  assert.equal(s.llm.calls.length, 2);
  assert.ok(!s.statuses().includes("idle"), "the ended think publishes no idle");
  assert.equal(s.says()[0]!.timing!.focusedAt !== undefined, true);
});

// @spec CTX-PROV-012, CTX-PROV-016, CTX-PROV-033
test("a mute or a pause ends the held think and the status is muted", async () => {
  for (const cmd of ["mute", "pause"]) {
    const s = setup();
    await holdOpen(s);
    await s.cortex.onEvent(control(cmd));
    await assertEnded(s, "muted");
    assert.ok(!s.statuses().includes("idle"), cmd);
    assert.equal(s.types().includes("voice.stop"), false, cmd);
  }
});

// @spec CTX-PROV-013, CTX-PROV-016, CTX-PROV-033
test("forget_context ends the held think: stream aborted, nothing spoken, status idle", async () => {
  const s = setup();
  await holdOpen(s);
  await s.cortex.onEvent(control("forget_context"));
  await assertEnded(s, "idle");
});

// @spec CTX-PROV-015, CTX-PROV-016, CTX-PROV-034, CTX-PROV-018, CTX-GATE-001
test("an ordinary focus for another utterance replaces the held think: stream aborted, no idle, and the new think is not declined as busy", async () => {
  const s = setup();
  await holdOpen(s);
  s.llm.rounds.push({ text: "[happy] Ordinary reply for the new sentence." });
  await s.cortex.onEvent(ordinary({ utteranceId: "u2", focus: { kind: "speech", who: "Chris", text: "a different sentence", mention: false } }));
  await waitFor(() => s.says().length === 1, "ordinary reply");
  assert.equal(s.llm.endedAborted[0], true);
  assert.equal(s.says()[0]!.text, "Ordinary reply for the new sentence.");
  assert.deepEqual(s.statuses().slice(0, 2), ["thinking", "thinking"], "the new think publishes thinking at its start");
  assert.ok(!s.statuses().slice(0, 3).includes("idle"), "the ended think publishes no idle");
  assert.equal(s.llm.calls.length, 2, "the held clauses are gone and the focus got its own model call");
  assert.equal(s.says()[0]!.timing!.confirmedAt, undefined);
});

// @spec CTX-PROV-015, CTX-PROV-034
test("an ordinary focus replaces the held think when it is the same utterance with other text, a chat focus, or names no utterance", async () => {
  const replacements = [
    ordinary({ focus: { kind: "speech", who: "Chris", text: "hey Coco, something else entirely", mention: false } }),
    chatFocus(),
    ordinary({ utteranceId: undefined }),
  ];
  for (const focus of replacements) {
    const s = setup();
    await holdOpen(s);
    s.llm.rounds.push({ text: "[happy] Ordinary reply for the new focus." });
    await s.cortex.onEvent(focus);
    await waitFor(() => s.says().length === 1, "ordinary reply");
    assert.equal(s.llm.endedAborted[0], true);
    assert.equal(s.says()[0]!.text, "Ordinary reply for the new focus.");
  }
});

// @spec CTX-PROV-018, CTX-GATE-001
test("a held provisional think is not a think in flight: an ordinary focus is thought on, not answered with a thinking status and no model call", async () => {
  const s = setup();
  await hold(s);
  const before = s.statuses().length;
  s.llm.rounds.push({ text: "[happy] Straight answer." });
  await s.cortex.onEvent(chatFocus());
  await waitFor(() => s.says().length === 1, "ordinary reply");
  assert.equal(s.llm.calls.length, 2);
  assert.equal(s.bus.of("brain.status")[before]!.detail, "engaged", "thinking with the new focus's reason, from the ordinary think's start");
});

// @spec CTX-PROV-017
test("a voice.stop never ends a held think: not aborted, and a later confirm still releases it", async () => {
  const s = setup();
  await hold(s);
  await s.cortex.onEvent(event("voice.stop", { reason: "barge-in" }));
  await s.cortex.onEvent(event("voice.stop", { reason: "barge-in", ids: ["x"] }));
  await sleep(30);
  assert.equal(s.llm.endedAborted[0], false);
  assert.equal(s.says().length, 0, "still held");
  await s.cortex.onEvent(confirm());
  await waitFor(() => s.clauses().some((c) => c.last), "released");
  assert.equal(s.llm.calls.length, 1);
});

// @spec CTX-PROV-027, CTX-PROV-016, CTX-PROV-033
test("an operator say ends the held think: the stream is aborted and the held clauses are never published", async () => {
  const s = setup();
  await holdOpen(s);
  await s.cortex.onEvent(control("say", { text: "hello from the operator" }));
  await waitFor(() => s.says().length === 1, "operator say");
  await waitFor(() => s.llm.ended[0] === true, "stream ended");
  assert.equal(s.llm.endedAborted[0], true);
  await s.cortex.onEvent(confirm()); // an ordinary focus now, blocked by the operator's pending line
  await sleep(40);
  assert.deepEqual(s.says().map((d) => d.text), ["hello from the operator"]);
  assert.equal(s.clauses().length, 0);
  assert.equal(s.statuses().at(-1), "speaking");
});

// ---- one think at a time (CTX-PROV-026, 028) ----

// @spec CTX-PROV-026
test("a provisional focus while a provisional think is held, or an ordinary think is in flight, is ignored: no status, no model call", async () => {
  const held = setup();
  await hold(held);
  const n = held.bus.published.length;
  await held.cortex.onEvent(provisional({ utteranceId: "u2", seq: 3 }));
  await sleep(40);
  assert.equal(held.bus.published.length, n, "nothing published");
  assert.equal(held.llm.calls.length, 1);

  const busy = setup();
  const g = gate();
  busy.llm.rounds.push({ text: "[happy] Ordinary reply, held open.", gate: g.promise });
  await busy.cortex.onEvent(ordinary({ utteranceId: undefined }));
  await opened(busy);
  const m = busy.bus.published.length;
  await busy.cortex.onEvent(provisional());
  await sleep(40);
  assert.equal(busy.bus.published.length, m);
  assert.equal(busy.llm.calls.length, 1);
  g.open();
});

// @spec CTX-PROV-028, CTX-EVT-005, CTX-GATE-009
test("during a hold a voice.done and the speaking timeout end a line without publishing idle", async () => {
  const s = setup({ cortex: { speaking_timeout_ms: 40 } });
  await hold(s);
  await other(s, "r1");
  await endOther(s, "r1");
  await other(s, "r2");
  await sleep(150); // r2 is released by the valve
  assert.ok(!s.statuses().includes("idle"), JSON.stringify(s.statuses()));
});

// ---- a confirm that finds no think, and the same-text focus (CTX-PROV-020, 023) ----

// @spec CTX-PROV-020
test("an ordinary focus for the same utterance with the same text is the confirmation: no new call, confirmedAt, the focus's timing", async () => {
  const s = setup();
  const focus = provisional();
  await s.cortex.onEvent(focus);
  await streamed(s);
  await sleep(20);
  const before = Date.now();
  await s.cortex.onEvent(ordinary());
  await waitFor(() => s.says().length === 1, "released");
  assert.equal(s.llm.calls.length, 1, "the held reply is used");
  assert.equal(s.llm.endedAborted[0], false);
  const t = s.says()[0]!.timing!;
  assert.ok(t.confirmedAt! >= before);
  assert.deepEqual([t.audioEndedAt, t.closedAt, t.heardAt], [150, 140, 160]);
  assert.equal(t.focusedAt, focus.ts);
});

// @spec CTX-PROV-023, CTX-SAY-006
test("a confirm with no held think is an ordinary focus built from its fields, focusedAt the resolve ts and no confirmedAt", async () => {
  const s = setup();
  // The final's speech reaches the window before its confirm, as it does in the running service.
  await s.cortex.onEvent(event("speech.heard", { speaker: "Chris", text: FINAL, durationMs: 900, source: "mic", utteranceId: "u1" }, "ears"));
  s.llm.rounds.push({ text: "[happy] Half past noon, I think." });
  const resolve = confirm({ injected: true, remember: false, reason: "engaged" });
  await s.cortex.onEvent(resolve);
  await waitFor(() => s.says().length === 1, "an ordinary reply");
  assert.match(userMsg(s), /hey Coco what time is it\?/);
  assert.match(userMsg(s), /Chris just said that out loud/, "the focus is in the nudge");
  const say = s.says()[0]!;
  assert.equal(say.reason, "engaged");
  assert.equal(say.injected, true);
  assert.equal(say.remember, false);
  assert.equal(say.timing!.focusedAt, resolve.ts);
  assert.deepEqual([say.timing!.audioEndedAt, say.timing!.closedAt, say.timing!.heardAt], [150, 140, 160]);
  assert.equal(say.timing!.confirmedAt, undefined);
  assert.equal(say.timing!.heldAt, undefined);
});

// ---- review round 1: release failure, snapshot, mutation coverage, redelivery, chat-kind early line ----

// @spec CTX-REL-010, CTX-PROV-037, CTX-PROV-038
test("a publish that fails on release ends the think: the cortex is not wedged in thinking, and the next focus is thought on", async () => {
  const s = setup();
  s.llm.rounds.push({ text: MULTI });
  await s.cortex.onEvent(provisional());
  await streamed(s);
  const real = s.bus.publish.bind(s.bus);
  let failed = false;
  s.bus.publish = (async (type: string, data: unknown) => {
    if (type === "brain.say" && !failed) { failed = true; throw new Error("bus down"); }
    return real(type as never, data as never);
  }) as typeof s.bus.publish;
  await s.cortex.onEvent(confirm()); // the release's first brain.say fails; the event itself does not throw
  await waitFor(() => s.statuses().at(-1) === "idle", "idle after the failed release");
  await sleep(20); // the think's finally clears its flag just after that publish
  s.llm.rounds.push({ text: "[happy] Hello again." });
  await s.cortex.onEvent(ordinary({ utteranceId: "u9", focus: { kind: "speech", who: "Chris", text: "another sentence", mention: false } }));
  await waitFor(() => s.says().length === 1, "the next focus is answered");
  assert.equal(s.says()[0]!.text, "Hello again.");
  assert.equal(s.llm.calls.length, 2);
});

// @spec CTX-PROV-005
test("an event that reaches the window during the recall wait stays out of the held prompt: the final is not duplicated", async () => {
  const s = setup({ recallK: 3, cortex: { recall_timeout_ms: 80 } });
  s.llm.rounds.push({ text: MULTI });
  await s.cortex.onEvent(provisional());
  await sleep(10); // the think is waiting for recall now
  await s.cortex.onEvent(event("speech.heard", { speaker: "Chris", text: FINAL, durationMs: 900, source: "mic", utteranceId: "u1" }, "ears"));
  await waitFor(() => s.llm.calls.length === 1, "model call");
  assert.ok(userMsg(s).includes(EARLY), "the early text is the transient line");
  assert.ok(!userMsg(s).includes("what time is it?"), "the final that arrived during the wait is not in the prompt");
});

// @spec CTX-PROV-003, CTX-PROV-015, CTX-GATE-001
test("a replaced held think does not clear the replacement's thinking flag: a third focus is declined while the replacement is in flight", async () => {
  // A's critic is still checking its clause when B replaces it, so A's think finishes after B has started.
  const s = setup({ critic: async () => { await sleep(100); return { ok: true }; } });
  const g = gate();
  s.llm.rounds.push({ text: MULTI }); // the held think A
  s.llm.rounds.push({ text: "[happy] B reply.", gate: g.promise }); // the replacement B, still reading
  await s.cortex.onEvent(provisional());
  await sleep(60); // A has read its reply and is in the critic
  await s.cortex.onEvent(ordinary({ utteranceId: "u2", focus: { kind: "speech", who: "Chris", text: "a different sentence", mention: false } }));
  await opened(s, 1);
  await sleep(150); // A's critic has returned and A's think has finished
  await s.cortex.onEvent(ordinary({ utteranceId: "u3", focus: { kind: "speech", who: "Chris", text: "a third sentence", mention: false } }));
  await sleep(120); // long enough for a think that wrongly started to reach its model call after its notes wait
  assert.equal(s.llm.calls.length, 2, "the third focus is declined, not thought on concurrently");
  assert.equal(s.statuses().at(-1), "thinking");
  g.open();
  await waitFor(() => s.says().length === 1, "B finishes");
});

// @spec CTX-PROV-016, CTX-PROV-031, CTX-PROV-033, CTX-STREAM-037
test("stop() ends a held think silently, and a late confirm after it speaks nothing", async () => {
  const s = setup();
  await holdOpen(s);
  const n = s.statuses().length;
  await s.cortex.stop();
  await sleep(20);
  assert.deepEqual(s.statuses().slice(n), [], "the held think publishes no status at shutdown");
  await s.cortex.onEvent(confirm());
  await sleep(40);
  assert.deepEqual(s.statuses().slice(n), [], "no later think starts a status after stop");
  assert.equal(s.says().length + s.clauses().length, 0, "nothing is spoken after stop");
  assert.equal(s.llm.calls.length, 1, "no think starts after stop");
});

// @spec CTX-PROV-014, CTX-PROV-016
test("a think ended during its recall wait makes no model call", async () => {
  const s = setup({ recallK: 3, cortex: { recall_timeout_ms: 80 } });
  s.llm.rounds.push({ text: MULTI });
  await s.cortex.onEvent(provisional());
  await sleep(10);
  await s.cortex.onEvent(withdraw());
  await sleep(120);
  assert.equal(s.llm.calls.length, 0, "the ended think asked the model nothing");
  assert.equal(s.says().length + s.clauses().length, 0);
});

// @spec CTX-STREAM-037, CTX-STREAM-013
test("a reply whose critic returns after stop() publishes no line", async () => {
  const s = setup({ critic: async () => { await sleep(150); return { ok: true }; } });
  s.llm.rounds.push({ text: "[happy] A reply that the critic is still checking." });
  const thinking = s.cortex.think({ reason: "mentioned", score: 1, focus: { kind: "speech", who: "Chris", text: FINAL, mention: false } });
  await sleep(80); // the reply is read and the critic is checking it
  await s.cortex.stop();
  await thinking;
  await sleep(20);
  assert.equal(s.says().length, 0, "the stopped line is not published after the critic returns");
});

// @spec CTX-PROV-019, CTX-PROV-025, CTX-SAY-006
test("a release takes the confirm's injected and remember flags, not the provisional focus's", async () => {
  const s = setup();
  await hold(s);
  await s.cortex.onEvent(confirm({ injected: true, remember: false }));
  await waitFor(() => s.says().length === 1, "released say");
  assert.equal(s.says()[0]!.injected, true);
  assert.equal(s.says()[0]!.remember, false);
});

// @spec CTX-PROV-030, CTX-PROV-009
test("a think that parks at its first tool call with no text before it stamps heldAt at the park", async () => {
  const s = setup({ withTool: true });
  s.llm.rounds.push({ calls: [call("c1")] }, { text: "[happy] It is noon." });
  s.bus.answerAfterMs = 5;
  const t0 = Date.now();
  await s.cortex.onEvent(provisional());
  await streamed(s);
  await sleep(30);
  assert.equal(s.bus.requests.length, 0, "parked: no request yet");
  const before = Date.now();
  await s.cortex.onEvent(confirm());
  await waitFor(() => s.line().some((e) => e.text === "It is noon."), "the reply after the call");
  const heldAt = s.says()[0]!.timing!.heldAt;
  assert.ok(heldAt !== undefined && heldAt >= t0 && heldAt <= before, `heldAt ${heldAt} stamped at the park`);
});

// @spec CTX-PROV-036, CTX-PROV-005
test("a reflex line that starts and ends while the held clauses are read does not stop their release", async () => {
  const s = setup();
  const g = gate();
  s.llm.rounds.push({ text: MULTI, gate: g.promise });
  await s.cortex.onEvent(provisional());
  await opened(s);
  await other(s, "r1"); // a reflex is playing while the clauses are cut
  g.open();
  await streamed(s);
  await endOther(s, "r1");
  await s.cortex.onEvent(confirm());
  await waitFor(() => s.says().length === 1, "released say");
  assert.equal(s.says()[0]!.text, "First clause is here,");
});

// @spec CTX-PROV-023
test("a redelivered confirm of the held think just released is ignored: no second reply", async () => {
  const s = setup();
  s.llm.rounds.push({ text: "[happy] Just one short line here." });
  await s.cortex.onEvent(provisional());
  await streamed(s);
  await s.cortex.onEvent(confirm());
  await waitFor(() => s.says().length === 1, "released say");
  await endOther(s, s.says()[0]!.id!); // the line has played: nothing is speaking when the duplicate arrives
  await sleep(20);
  await s.cortex.onEvent(confirm());
  await sleep(40);
  assert.equal(s.llm.calls.length, 1, "no second model call");
  assert.equal(s.says().length, 1, "no second reply");
});

// @spec CTX-PROV-005
test("a chat-kind provisional focus renders no [voice] line in its prompt", async () => {
  const s = setup();
  s.llm.rounds.push({ text: MULTI });
  await s.cortex.onEvent(event("attention.focus", { reason: "engaged", score: 1, provisional: true, utteranceId: "u1", seq: 0, focus: { kind: "chat", who: "bob", platform: "twitch", text: "hello there Coco", mention: false } }, "salience"));
  await streamed(s);
  assert.ok(!userMsg(s).includes("[voice]"), "no unquoted chat text as a voice line");
});

// @spec CTX-STREAM-037, CTX-PROV-016
test("stop() during the recall wait: the think makes no model call", async () => {
  const s = setup({ recallK: 3, cortex: { recall_timeout_ms: 80 } });
  s.llm.rounds.push({ text: MULTI });
  const thinking = s.cortex.think({ reason: "mentioned", score: 1, focus: { kind: "speech", who: "Chris", text: FINAL, mention: false } });
  await sleep(10);
  await s.cortex.stop();
  await thinking;
  await sleep(100);
  assert.equal(s.llm.calls.length, 0);
  assert.equal(s.says().length, 0);
});

/** The clause events published after index `from`: text, last, cut, seq and through. */
const clausesFrom = (s: S, from: number) =>
  s.bus.published.slice(from).filter((e) => e.type === "brain.clause").map((e) => {
    const d = e.data as { text: string; seq: number; last?: true; cut?: string; through?: number };
    return [d.text, d.last ?? null, d.cut ?? null, d.seq, d.through ?? null];
  });

// @spec CTX-STREAM-037, CTX-PROV-038
test("stop() during a release's brain.say publish: the say in flight is the last line, no later clause or speaking status, and the line closes stopped", async () => {
  const s = setup();
  s.llm.rounds.push({ text: MULTI });
  await s.cortex.onEvent(provisional());
  await streamed(s);
  const g = gate();
  const real = s.bus.publish.bind(s.bus);
  let once = true;
  s.bus.publish = (async (type: string, data: unknown) => {
    if (type === "brain.say" && once) { once = false; await g.promise; }
    return real(type as never, data as never);
  }) as typeof s.bus.publish;
  const p = s.cortex.onEvent(confirm());
  await sleep(10);
  await s.cortex.stop();
  const atStop = s.bus.published.length;
  g.open();
  await p;
  await sleep(80);
  assert.deepEqual(clausesFrom(s, atStop), [["", true, "stopped", 1, 0]], "only the closing clause follows the say, through the one clause that was published");
  assert.ok(!s.bus.published.slice(atStop).some((e) => e.type === "brain.status" && (e.data as { state: string }).state === "speaking"), "no speaking status after stop");
  assert.equal(s.says().length, 1);
  assert.ok(!s.line().some((e) => e.text === "second clause follows,"), "the held clauses are dropped");
});

// @spec CTX-STREAM-037, CTX-PROV-038
test("stop() during a release with the stream still open: the release's first output is the last, the stream is aborted and the line closes stopped", async () => {
  const s = setup();
  const hold = gate();
  s.llm.rounds.push({ text: "[happy] Only one clause here, then more", hold: hold.promise });
  await s.cortex.onEvent(provisional());
  await opened(s);
  const g = gate();
  const real = s.bus.publish.bind(s.bus);
  let once = true;
  s.bus.publish = (async (type: string, data: unknown) => {
    if (type === "brain.say" && once) { once = false; await g.promise; }
    return real(type as never, data as never);
  }) as typeof s.bus.publish;
  const p = s.cortex.onEvent(confirm());
  await sleep(10);
  await s.cortex.stop();
  const atStop = s.bus.published.length;
  g.open();
  await p;
  hold.open();
  await sleep(80);
  assert.deepEqual(clausesFrom(s, atStop), [["", true, "stopped", 1, 0]]);
  assert.equal(s.llm.endedAborted[0], true, "the model stream was aborted");
});

// @spec CTX-CTRL-008, CTX-STREAM-037, CTX-PROV-038
test("a mute during a release's brain.say publish closes the line muted and publishes no later clause", async () => {
  const s = setup();
  s.llm.rounds.push({ text: MULTI });
  await s.cortex.onEvent(provisional());
  await streamed(s);
  const g = gate();
  const real = s.bus.publish.bind(s.bus);
  let once = true;
  s.bus.publish = (async (type: string, data: unknown) => {
    if (type === "brain.say" && once) { once = false; await g.promise; }
    return real(type as never, data as never);
  }) as typeof s.bus.publish;
  const p = s.cortex.onEvent(confirm());
  await sleep(10);
  await s.cortex.onEvent(control("mute"));
  const atMute = s.bus.published.length;
  g.open();
  await p;
  await sleep(80);
  assert.deepEqual(clausesFrom(s, atMute), [["", true, "muted", 1, 0]]);
});

// @spec CTX-STREAM-024, CTX-STREAM-037, CTX-PROV-038
test("a brain.clause that fails mid-release closes the reply failed: the line is not left half-published", async () => {
  const s = setup();
  s.llm.rounds.push({ text: MULTI });
  await s.cortex.onEvent(provisional());
  await streamed(s);
  const real = s.bus.publish.bind(s.bus);
  let failed = false;
  s.bus.publish = (async (type: string, data: unknown) => {
    if (type === "brain.clause" && !failed) { failed = true; throw new Error("bus down"); }
    return real(type as never, data as never);
  }) as typeof s.bus.publish;
  await s.cortex.onEvent(confirm());
  await sleep(80);
  assert.equal(s.says().length, 1);
  assert.ok(!s.line().some((e) => e.text === "second clause follows,"), "the failed clause was not published");
  assert.deepEqual(clausesFrom(s, 0).filter((c) => c[2] === "failed"), [["", true, "failed", 1, 0]], "the reply closes failed");
});

/** A release whose output `pred` names is held in flight, a halt (stop or mute) lands on it, and the clauses published after the halt are returned. */
async function haltInFlight(text: string, pred: (type: string, data: { last?: true; text?: string; seq?: number }) => boolean, halt: "stop" | "mute", cortex: Record<string, unknown> = {}) {
  const s = setup({ cortex });
  s.llm.rounds.push({ text });
  await s.cortex.onEvent(provisional());
  await streamed(s);
  const g = gate();
  const real = s.bus.publish.bind(s.bus);
  let once = true;
  s.bus.publish = (async (type: string, data: unknown) => {
    if (once && pred(type, data as never)) { once = false; await g.promise; }
    return real(type as never, data as never);
  }) as typeof s.bus.publish;
  const p = s.cortex.onEvent(confirm());
  await sleep(15);
  const atHalt = s.bus.published.length;
  if (halt === "stop") await s.cortex.stop();
  else await s.cortex.onEvent(control("mute"));
  g.open();
  await p;
  await sleep(80);
  return { s, afterHalt: clausesFrom(s, atHalt), hit: !once };
}

// @spec CTX-STREAM-028, CTX-STREAM-037, CTX-PROV-038
test("a halt during a one-clause reply's in-flight brain.say publishes no further clause, under stop and under mute", async () => {
  for (const halt of ["stop", "mute"] as const) {
    const { afterHalt, hit } = await haltInFlight("[happy] Just one short clause here.", (t) => t === "brain.say", halt);
    assert.equal(hit, true, `${halt}: the say was held in flight`);
    assert.deepEqual(afterHalt, [], `${halt}: the one-clause reply has no clause after the say`);
  }
});

// @spec CTX-STREAM-028, CTX-STREAM-037, CTX-PROV-038
test("a halt during the last content clause's in-flight publish closes nothing a second time, under stop and under mute", async () => {
  for (const halt of ["stop", "mute"] as const) {
    const { afterHalt, hit } = await haltInFlight(MULTI, (t, d) => t === "brain.clause" && d.last === true && d.text !== "", halt);
    assert.equal(hit, true, `${halt}: the last clause was held in flight`);
    assert.deepEqual(afterHalt, [["and a third to end.", true, null, 2, 2]], `${halt}: only the in-flight last clause, no second closing clause`);
  }
});

// @spec CTX-STREAM-028, CTX-STREAM-037, CTX-PROV-038
test("a halt during the queued closing clause (length cut) publishes that closing clause once, under stop and under mute", async () => {
  for (const halt of ["stop", "mute"] as const) {
    const { afterHalt, hit } = await haltInFlight(MULTI, (t, d) => t === "brain.clause" && d.last === true && d.text === "", halt, { max_clauses: 2 });
    assert.equal(hit, true, `${halt}: the closing clause was held in flight`);
    assert.deepEqual(afterHalt, [["", true, "length", 2, 1]], `${halt}: the closing clause is published once, through the clause before it`);
  }
});
