import { test } from "node:test";
import assert from "node:assert/strict";
import { waitFor } from "@cohost/testing";
import { EARLY, call, confirm, gate, opened, other, provisional, setup, sleep, streamed, type S } from "./provisional.fixture.js";

// An interjected confirm (cortex-design.md, Provisional think, An interjected confirm; CTX-INTJ-001 to 006): salience asks the cortex
// to speak while the person is still talking. The held think is released only if it is ready at that moment.

const MULTI = "[happy] First clause is here, second clause follows, and a third to end.";
const interjected = (over: Record<string, unknown> = {}) =>
  confirm({ interjected: true, focus: { kind: "speech", source: "mic", who: "Chris", text: EARLY, mention: false }, timing: { audioEndedAt: 100 }, ...over });

/** Marks the working-memory window as it stands at the moment each brain.say reaches the bus. */
function watchWindow(s: S): { atSay: string[][] } {
  const seen = { atSay: [] as string[][] };
  s.bus.onSay = () => { seen.atSay.push(s.cortex.ctx.all().map((e) => e.kind === "speech" ? (e.unfinished ? "unfinished" : "speech") : e.kind)); };
  return seen;
}

// @spec CTX-INTJ-001, CTX-INTJ-002, CTX-INTJ-004, CTX-INTJ-005, CTX-PROV-035, CTX-PROV-030
test("an interjected confirm releases a ready think: the unfinished line first, then a brain.say with interjected, no confirmedAt, all clauses", async () => {
  const s = setup({ cortex: { hold_limit_ms: 5000 } });
  const seen = watchWindow(s);
  s.llm.rounds.push({ text: MULTI });
  await s.cortex.onEvent(provisional());
  await streamed(s);
  await s.cortex.onEvent(interjected());
  await waitFor(() => s.clauses().some((c) => c.last), "closing clause");
  assert.deepEqual(seen.atSay, [["unfinished"]], "the unfinished line is in the window before the brain.say is published");
  const entry = s.cortex.ctx.all()[0]!;
  assert.equal(entry.kind, "speech");
  assert.deepEqual(entry.kind === "speech" && [entry.unfinished, entry.utteranceId, entry.speaker, entry.text], [true, "u1", "Chris", EARLY]);
  assert.deepEqual(s.cortex.ctx.all().map((e) => e.kind), ["speech", "self"], "the self entry follows the unfinished line");
  const say = s.says()[0]!;
  assert.equal(say.interjected, true);
  assert.equal(say.timing!.confirmedAt, undefined);
  assert.ok(say.timing!.heldAt !== undefined);
  assert.deepEqual(s.line().map((e) => e.text).filter(Boolean), ["First clause is here,", "second clause follows,", "and a third to end."]);
  assert.equal(s.llm.calls.length, 1);
});

// @spec CTX-INTJ-001, CTX-INTJ-004
test("an interjected confirm releases a think that has its first clause held while the stream is still open", async () => {
  const s = setup();
  const g = gate();
  s.llm.rounds.push({ text: MULTI, hold: g.promise });
  await s.cortex.onEvent(provisional());
  await opened(s);
  await sleep(30);
  await s.cortex.onEvent(interjected());
  await waitFor(() => s.says().length === 1, "released say");
  assert.equal(s.says()[0]!.interjected, true);
  assert.equal(s.says()[0]!.more, true);
  g.open();
  await waitFor(() => s.clauses().some((c) => c.last), "closing clause");
});

/** Asserts nothing was spoken, the think is gone and the status is not thinking after the interjected resolve (CTX-INTJ-003, CTX-INTJ-006). */
async function assertNotReleased(s: S, thinkingBefore: number): Promise<void> {
  await sleep(40);
  assert.equal(s.says().length + s.clauses().length, 0, "nothing spoken");
  assert.ok(s.statuses().length > thinkingBefore, "a status was published");
  assert.notEqual(s.statuses().at(-1), "thinking");
  assert.equal(s.llm.calls.length, 1, "never taken as an ordinary focus");
}

// @spec CTX-INTJ-003, CTX-INTJ-006, CTX-PROV-016
test("an interjected confirm for a think that is not ready ends it: stream aborted, nothing spoken, a non-thinking status", async () => {
  const s = setup();
  const g = gate();
  s.llm.rounds.push({ text: MULTI, gate: g.promise }); // no clause yet
  await s.cortex.onEvent(provisional());
  await opened(s);
  const n = s.statuses().length;
  await s.cortex.onEvent(interjected());
  await waitFor(() => s.llm.ended[0] === true, "stream ended");
  assert.equal(s.llm.endedAborted[0], true);
  await assertNotReleased(s, n);
  assert.equal(s.statuses().at(-1), "idle");
  assert.deepEqual(s.cortex.ctx.all(), [], "no unfinished line was pushed");
});

// @spec CTX-INTJ-001, CTX-INTJ-003
test("an interjected confirm with an llm critic still collecting the whole reply is not ready", async () => {
  const s = setup({ kind: "llm" });
  const g = gate();
  s.llm.rounds.push({ text: MULTI, hold: g.promise });
  await s.cortex.onEvent(provisional());
  await opened(s);
  await sleep(30);
  const n = s.statuses().length;
  await s.cortex.onEvent(interjected());
  await assertNotReleased(s, n);
  assert.equal(s.criticCalls.length, 0);
});

// @spec CTX-INTJ-003, CTX-INTJ-006
test("an interjected confirm for a think parked at a tool call ends it: no tool.request, nothing spoken", async () => {
  const s = setup({ withTool: true });
  s.llm.rounds.push({ text: "[happy] Let me check the clock.", calls: [call("c1")] });
  await s.cortex.onEvent(provisional());
  await streamed(s);
  const n = s.statuses().length;
  await s.cortex.onEvent(interjected());
  await assertNotReleased(s, n);
  assert.equal(s.bus.requests.length, 0);
});

// @spec CTX-INTJ-003, CTX-INTJ-006
test("an interjected confirm for a think that holds no line (a veto) ends it: nothing spoken, a non-thinking status", async () => {
  const s = setup({ critic: () => ({ ok: false, note: "no" }) });
  s.llm.rounds.push({ text: MULTI });
  await s.cortex.onEvent(provisional());
  await streamed(s);
  const n = s.statuses().length;
  await s.cortex.onEvent(interjected());
  await assertNotReleased(s, n);
  assert.equal(s.statuses().at(-1), "idle");
});

// @spec CTX-INTJ-003, CTX-INTJ-006
test("an interjected confirm with no think held, or for another utterance or seq, speaks nothing and is never an ordinary focus", async () => {
  const none = setup();
  await none.cortex.onEvent(interjected());
  await sleep(40);
  assert.equal(none.llm.calls.length, 0);
  assert.equal(none.says().length, 0);
  assert.deepEqual(none.statuses(), ["idle"], "a status other than thinking tells salience nothing was spoken");

  const s = setup();
  s.llm.rounds.push({ text: MULTI });
  await s.cortex.onEvent(provisional());
  await streamed(s);
  await s.cortex.onEvent(interjected({ utteranceId: "u2" }));
  await sleep(40);
  assert.equal(s.llm.calls.length, 1, "no ordinary think on the resolve");
  assert.equal(s.says().length, 0);
  assert.notEqual(s.statuses().at(-1), "thinking");
});

// @spec CTX-INTJ-006, CTX-PROV-033
test("the status of an unreleased interjected confirm is the no-line status: speaking while a line is pending", async () => {
  const s = setup();
  const g = gate();
  s.llm.rounds.push({ text: MULTI, gate: g.promise });
  await s.cortex.onEvent(provisional());
  await opened(s);
  await other(s);
  await s.cortex.onEvent(interjected());
  await waitFor(() => s.statuses().at(-1) === "speaking", "speaking");
  assert.equal(s.says().length, 0);
});
