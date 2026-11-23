import { test } from "node:test";
import assert from "node:assert/strict";
import { ModuleSchema } from "@cohost/config";
import { Module } from "@cohost/modules";
import type { ChatEvent, ChatMessage, ChatProvider, ChatRequest, ChatResult } from "@cohost/llm";
import type { BusEvent, EventInput, EventType } from "@cohost/bus";
import { FakeBus, event, recordingLog, silentLog, testConfig, waitFor } from "@cohost/testing";
import { Cortex } from "../src/cortex.js";
import type { CriticInput, CriticOutput } from "../src/critic.js";

// The streamed reply: the cortex reads `llm.stream`, cuts the text into clauses and publishes `brain.say` then `brain.clause`
// (cortex-design.md, Streaming the reply). Every test drives `think()` through a scripted stream.

/** One thing the scripted stream does: yield a text delta, wait for a gate, or throw. */
type Step = string | { gate: Promise<void> } | { fail: Error };
interface Plan { steps: Step[]; finish?: ChatResult["finish"] }

const gate = () => {
  let open!: () => void;
  const promise = new Promise<void>((r) => { open = r; });
  return { promise, open };
};

class StreamLlm implements ChatProvider {
  readonly name = "fake";
  readonly model = "fake";
  /** The plans the next `stream()` calls follow, in order; a call past the end replies `[happy] hey chat!`. */
  plans: Plan[] = [];
  calls: ChatMessage[][] = [];
  opts: (ChatRequest | undefined)[] = [];
  /** Whether each call's signal was aborted by the time its stream stopped. */
  endedAborted: boolean[] = [];
  async chat(): Promise<string> { throw new Error("the reply must be read with stream(), not chat()"); }
  async complete(): Promise<ChatResult> { throw new Error("the reply must be read with stream(), not complete()"); }
  async ping() { return true; }
  async *stream(msgs: ChatMessage[], opts?: ChatRequest): AsyncGenerator<ChatEvent> {
    const n = this.calls.length;
    this.calls.push(msgs);
    this.opts.push(opts);
    const plan = this.plans[n] ?? { steps: ["[happy] hey chat!"] };
    let text = "";
    try {
      for (const step of plan.steps) {
        if (opts?.signal?.aborted) throw opts.signal.reason ?? new Error("aborted");
        if (typeof step === "string") { text += step; yield { type: "text", delta: step }; continue; }
        if ("fail" in step) throw step.fail;
        await step.gate;
      }
      if (opts?.signal?.aborted) throw opts.signal.reason ?? new Error("aborted");
      const message = { role: "assistant" as const, content: text };
      yield { type: "done", result: { text, toolCalls: [], finish: plan.finish ?? "stop", message } };
    } finally {
      this.endedAborted[n] = opts?.signal?.aborted ?? false;
    }
  }
  system(i = -1) { return this.calls.at(i)![0]!.content; }
}

/** A bus that hands the cortex its own `brain.say` and `brain.clause` back, as the real bus does. */
class LoopBus extends FakeBus {
  cortex?: Cortex;
  override async publish<T extends EventType>(type: T, data: EventInput<T>): Promise<string> {
    const id = await super.publish(type, data);
    if (type === "brain.say" || type === "brain.clause") await this.cortex?.onEvent(event(type, data, "cortex"));
    return id;
  }
}

type CriticKind = "rules" | "llm" | "http";
function setup(opts: { cfg?: Record<string, unknown>; kind?: CriticKind; critic?: (i: CriticInput) => CriticOutput | Promise<CriticOutput> } = {}) {
  const kind = opts.kind ?? "rules";
  const cortexCfg = {
    recall_timeout_ms: 100, clause_min_chars: 10, clause_max_chars: 60, max_clauses: 8,
    ...(kind === "rules" ? {} : { critic: kind === "llm" ? { kind } : { kind, url: "http://critic.invalid" } }),
    ...(opts.cfg ?? {}),
  };
  const cfg = testConfig({ brain: { memory: { recall_k: 0 }, cortex: cortexCfg } });
  const bus = new LoopBus();
  const llm = new StreamLlm();
  const rec = recordingLog();
  const calls: CriticInput[] = [];
  const run = async (i: CriticInput) => { calls.push(i); return (opts.critic ?? (() => ({ ok: true })))(i); };
  const critic = kind === "rules"
    ? new Module<CriticInput, CriticOutput>("critic", ModuleSchema.parse({}), {} as never, { rules: run as never }, silentLog)
    : ({ kind, run } as unknown as Module<CriticInput, CriticOutput>);
  const cortex = new Cortex({ cfg, bus, llm, critic, log: rec.log, loadPersonality: () => "You are Coco." });
  bus.cortex = cortex;
  return {
    cfg, bus, llm, cortex, rec, criticCalls: calls,
    statuses: () => bus.of("brain.status").map((s) => s.state),
    /** The streamed line's events in publish order: `say`, then each `clause`. */
    line: () => bus.published.filter((p) => p.type === "brain.say" || p.type === "brain.clause").map((p) => p.data as BusEvent<"brain.say">["data"] & BusEvent<"brain.clause">["data"]),
    closings: () => bus.of("brain.clause").filter((c) => c.last),
  };
}
type S = ReturnType<typeof setup>;

const mention = () => ({ reason: "mentioned", score: 1, focus: { kind: "chat" as const, who: "bob", platform: "twitch" as const, userId: "u1", text: "hey Coco, how are you?", mention: true } });
const other = (cortex: Cortex, id = "reflex", source = "salience") => cortex.onEvent(event("brain.say", { id, text: "a reflex line", emotion: "neutral" }, source));
const endOther = (cortex: Cortex, id = "reflex") => cortex.onEvent(event("voice.done", { id, seq: 0, sink: "x" }));
/** The `brain.clause` texts of a line, in order, whether closing or not. */
/** A bus payload as plain JSON, so an absent member and an `undefined` one compare alike. */
const J = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const clauseTexts = (s: S) => s.bus.of("brain.clause").map((c) => c.text);

/** Runs a think over a scripted reply with no gates, returning once the think has ended. */
async function run(s: S, steps: Step[], finish?: ChatResult["finish"]): Promise<void> {
  s.llm.plans.push({ steps, finish });
  await s.cortex.think(mention());
}

// ---- the clause cutter: tags, boundaries, length, cleaning (CTX-STREAM-005 to 010, 014, 015) ----

// @spec CTX-STREAM-005, CTX-STREAM-007, CTX-STREAM-017, CTX-STREAM-018, CTX-STREAM-020, CTX-STREAM-027, CTX-SAY-001
test("the leading Name:, [emotion] and [gesture] are held until closed, then the first clause is brain.say, the next brain.clause", async () => {
  const s = setup();
  const g = gate();
  s.llm.plans.push({ steps: ["Coco: [lau", "gh] [gest", { gate: g.promise }, "ure:wave] Hello everyone, ", "and welcome in."] });
  const thinking = s.cortex.think({ ...mention(), injected: true, remember: false });
  await waitFor(() => s.llm.calls.length === 1, "stream opened");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(s.bus.of("brain.say").length, 0, "nothing is published while the tags are open");
  g.open();
  await thinking;
  const [say] = s.bus.of("brain.say");
  assert.equal(say!.text, "Hello everyone,");
  assert.equal(say!.emotion, "laugh");
  assert.equal(say!.gesture, "wave");
  assert.equal(say!.reason, "mentioned");
  assert.equal(say!.more, true);
  assert.equal(say!.injected, true, "the focus's injection flags ride on the brain.say");
  assert.equal(say!.remember, false);
  assert.ok(say!.timing?.llmStartedAt !== undefined);
  assert.deepEqual(J(s.bus.of("brain.clause")), [{ id: say!.id, seq: 1, text: "and welcome in.", last: true, through: 1 }]);
  assert.deepEqual(s.bus.published.map((p) => p.type).filter((t) => t !== "memory.notes.request"), ["brain.status", "brain.say", "brain.status", "brain.clause"]);
  assert.deepEqual(s.statuses(), ["thinking", "speaking"]);
  assert.equal(s.bus.of("brain.status")[1]!.detail, "Hello everyone,");
});

// @spec CTX-STREAM-017, CTX-STREAM-020, CTX-STREAM-018
test("a later clause is a brain.clause with seq from 1, no last, and publishes no brain.status", async () => {
  const s = setup();
  const g = gate();
  s.llm.plans.push({ steps: ["[happy] First clause is here, ", "second clause follows, ", { gate: g.promise }, "and a third to end."] });
  const thinking = s.cortex.think(mention());
  await waitFor(() => s.bus.of("brain.clause").length === 1, "clause 1");
  assert.deepEqual(J(s.bus.of("brain.clause")[0]), { id: s.bus.of("brain.say")[0]!.id, seq: 1, text: "second clause follows,", });
  assert.deepEqual(s.statuses(), ["thinking", "speaking"], "no status for a later clause");
  g.open();
  await thinking;
  assert.deepEqual(J(s.line().map((e) => [e.seq ?? null, e.text, e.last ?? null])), [[null, "First clause is here,", null], [1, "second clause follows,", null], [2, "and a third to end.", true]]);
});

// @spec CTX-STREAM-019, CTX-STREAM-028
test("a reply that is one clause is a brain.say without more and no brain.clause", async () => {
  const s = setup();
  await run(s, ["[happy] Just one short line here."]);
  const [say] = s.bus.of("brain.say");
  assert.equal(say!.text, "Just one short line here.");
  assert.equal(say!.more, undefined);
  assert.equal(s.bus.of("brain.clause").length, 0);
});

// @spec CTX-STREAM-005
test("text after Name: that does not begin with [ decides the tags at once: no emotion, no gesture", async () => {
  const s = setup();
  await run(s, ["Coco: Hello everyone, welcome in."]);
  const [say] = s.bus.of("brain.say");
  assert.equal(say!.text, "Hello everyone,");
  assert.equal(say!.emotion, "neutral");
  assert.equal(say!.gesture, undefined);
});

// @spec CTX-STREAM-007
test("an unknown emotion tag is neutral and a gesture is kept as given", async () => {
  const s = setup();
  await run(s, ["[bogus] [gesture:shrug] Hello everyone, welcome in."]);
  const [say] = s.bus.of("brain.say");
  assert.deepEqual([say!.emotion, say!.gesture, say!.text], ["neutral", "shrug", "Hello everyone,"]);
});

// @spec CTX-STREAM-005, CTX-STREAM-006
test("80 characters with a [ still open: emotion neutral, no gesture, and the reply goes on from the start of the buffer", async () => {
  const s = setup();
  const open = "[this bracket runs on and on without closing for well over eighty characters of text";
  assert.ok(open.length > 80);
  await run(s, [open, " ends] and then real words, follow here."]);
  const [say] = s.bus.of("brain.say");
  assert.ok(say, "the reply is not lost");
  assert.equal(say!.emotion, "neutral");
  assert.equal(say!.gesture, undefined);
  assert.match(say!.text + clauseTexts(s).join(" "), /real words/);
});

// @spec CTX-STREAM-008
test("a clause ends at each boundary mark followed by whitespace once it has clause_min_chars", async () => {
  for (const mark of [".", "!", "?", "…", ";", ":", ","]) {
    const s = setup();
    await run(s, [`[happy] Hello there everyone${mark} and the rest of it`]);
    assert.equal(s.bus.of("brain.say")[0]!.text, `Hello there everyone${mark}`, `mark ${mark}`);
    assert.deepEqual(clauseTexts(s), ["and the rest of it"]);
  }
  for (const mark of ["。", "！", "？", "、", "，", "；", "："]) {
    const s = setup();
    await run(s, [`[happy] 你好世界我们开始吧${mark} 然后继续说下去`]);
    assert.equal(s.bus.of("brain.say")[0]!.text, `你好世界我们开始吧${mark}`, `mark ${mark}`);
  }
});

// @spec CTX-STREAM-008
test("a boundary that arrives split from its following whitespace still cuts", async () => {
  const s = setup();
  await run(s, ["[happy] Hello there everyone,", " and more", " words."]);
  assert.equal(s.bus.of("brain.say")[0]!.text, "Hello there everyone,");
  assert.deepEqual(clauseTexts(s), ["and more words."]);
});

// @spec CTX-STREAM-008, CTX-STREAM-033
test("a boundary before clause_min_chars is not taken: the text joins the next clause", async () => {
  const long = setup({ cfg: { clause_min_chars: 24, clause_max_chars: 160 } });
  await run(long, ["[happy] Oh, that is really quite something, right."]);
  assert.equal(long.bus.of("brain.say")[0]!.text, "Oh, that is really quite something,");
  const short = setup({ cfg: { clause_min_chars: 3, clause_max_chars: 160 } });
  await run(short, ["[happy] Oh, that is really quite something, right."]);
  assert.equal(short.bus.of("brain.say")[0]!.text, "Oh,", "the same reply cuts earlier under a lower clause_min_chars");
});

// @spec CTX-STREAM-009
test("a mark inside a bracketed span, or not followed by whitespace, is not a boundary", async () => {
  const s = setup();
  await run(s, ["[happy] Version v1.2 costs 3.5 dollars[wave, smile. ok] today, and more."]);
  assert.equal(s.bus.of("brain.say")[0]!.text, "Version v1.2 costs 3.5 dollars today,");
});

// @spec CTX-STREAM-010, CTX-STREAM-033
test("clause_max_chars cuts a long unpunctuated run at the last whitespace, or at the length when there is none", async () => {
  const words = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho";
  const s = setup({ cfg: { clause_min_chars: 10, clause_max_chars: 30 } });
  await run(s, ["[happy] ", words]);
  const texts = [s.bus.of("brain.say")[0]!.text, ...clauseTexts(s)].filter(Boolean);
  assert.ok(texts.length >= 3);
  for (const t of texts) {
    assert.ok(t.length <= 30, `clause over the limit: ${t}`);
    assert.ok(words.includes(t), `a clause is whole words: ${t}`);
  }
  assert.equal(texts.join(" "), words);

  const solid = setup({ cfg: { clause_min_chars: 10, clause_max_chars: 30 } });
  await run(solid, ["[happy] ", "x".repeat(70)]);
  assert.deepEqual([solid.bus.of("brain.say")[0]!.text, ...clauseTexts(solid)].map((t) => t.length), [30, 30, 10]);
});

// @spec CTX-STREAM-014
test("each clause is cleaned: bracketed spans, « », surrounding quotes; a Name: is stripped from the first clause only", async () => {
  const s = setup();
  await run(s, ['Coco: «Hello» there everyone, "and then some more," Max: runs fast here, bye now.']);
  assert.equal(s.bus.of("brain.say")[0]!.text, "Hello there everyone,");
  assert.deepEqual(clauseTexts(s), ["and then some more,", "Max: runs fast here,", "bye now."]);
});

// @spec CTX-STREAM-015
test("a clause with no word character after cleaning is dropped, and seq has no gap", async () => {
  const s = setup();
  await run(s, ["[happy] Hello there everyone, !!!!!!!!!!!! Then more words follow."]);
  assert.equal(s.bus.of("brain.say")[0]!.text, "Hello there everyone,");
  assert.deepEqual(s.bus.of("brain.clause").map((c) => [c.seq, c.text]), [[1, "Then more words follow."]]);
});

// ---- checks: the critic, the repetition check, the re-check, in order (CTX-GATE-013, CTX-STREAM-016, CTX-CRITIC-001) ----

// @spec CTX-CRITIC-001, CTX-STREAM-016
test("rules critic: asked once, on the first clause, before it is published; later clauses do not ask", async () => {
  const s = setup({ critic: (i) => { assert.equal(s.bus.of("brain.say").length, 0, "asked before the first clause is published"); return { ok: true }; } });
  await run(s, ["[happy] Hello there everyone, and a second clause, and a third one."]);
  assert.equal(s.criticCalls.length, 1);
  assert.deepEqual([s.criticCalls[0]!.text, s.criticCalls[0]!.emotion, s.criticCalls[0]!.reason], ["Hello there everyone,", "happy", "mentioned"]);
  assert.equal(s.bus.of("brain.clause").length, 2);
});

// @spec CTX-CRITIC-001, CTX-PROMPT-005, CTX-GATE-013
test("llm critic: reads the whole stream first, passes the parsed whole reply once, then publishes its clauses", async () => {
  const s = setup({ kind: "llm" });
  const g = gate();
  s.llm.plans.push({ steps: ["[happy] [gesture:wave] «Coco: hello there, friends and ", "all», second part", { gate: g.promise }, " goes here.\nA second line is ignored."] });
  const thinking = s.cortex.think(mention());
  await waitFor(() => s.llm.calls.length === 1, "stream");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(s.criticCalls.length, 0, "the critic waits for the whole reply");
  assert.equal(s.bus.of("brain.say").length, 0, "nothing is published before the stream ends");
  g.open();
  await thinking;
  assert.equal(s.criticCalls.length, 1);
  assert.deepEqual([s.criticCalls[0]!.text, s.criticCalls[0]!.emotion], ["hello there, friends and all, second part goes here.", "happy"]);
  const [say] = s.bus.of("brain.say");
  assert.deepEqual([say!.text, say!.gesture, say!.more], ["hello there,", "wave", true]);
  assert.deepEqual(clauseTexts(s), ["friends and all,", "second part goes here."]);
});

// @spec CTX-CRITIC-001
test("llm critic: a rewrite is cut into the clauses; a veto publishes no brain.say", async () => {
  const rewrite = setup({ kind: "http", critic: () => ({ ok: true, text: "Rewritten line here, with two parts." }) });
  await run(rewrite, ["[happy] Original text that is wordy."]);
  assert.equal(rewrite.bus.of("brain.say")[0]!.text, "Rewritten line here,");
  assert.deepEqual(clauseTexts(rewrite), ["with two parts."]);
  const veto = setup({ kind: "llm", critic: () => ({ ok: false, note: "no" }) });
  await run(veto, ["[happy] Original text that is wordy."]);
  assert.equal(veto.bus.of("brain.say").length, 0);
  assert.equal(veto.bus.of("brain.clause").length, 0);
});

// @spec CTX-CRITIC-001
test("rules critic with a veto on the first clause: no brain.say and the stream is not published from", async () => {
  const s = setup({ critic: () => ({ ok: false, note: "no" }) });
  await run(s, ["[happy] Hello there everyone, and more."]);
  assert.equal(s.bus.of("brain.say").length, 0);
  assert.equal(s.bus.of("brain.clause").length, 0);
  assert.equal(s.statuses().at(-1), "idle");
  assert.deepEqual([s.llm.calls.length, s.criticCalls.length], [1, 1], "the reply was read from llm.stream and reached the critic");
});

// @spec CTX-GATE-013, CTX-REPEAT-001, CTX-REPEAT-010
test("the critic is asked before the repetition check: a repeating first clause still reaches the critic", async () => {
  const s = setup();
  s.cortex.ctx.pushSelf("Hello there everyone, welcome.", "neutral", Date.now(), "old");
  await run(s, ["[happy] Hello there everyone welcome."]);
  assert.equal(s.criticCalls.length, 1);
  assert.equal(s.bus.of("brain.say").length, 0);
});

// @spec CTX-GATE-013, CTX-GATE-005
test("the mute and busy re-check runs after the critic returns, so a mute during the critic drops the first clause", async () => {
  const s = setup({ critic: async () => { await s.cortex.onEvent(event("control", { cmd: "mute" })); return { ok: true }; } });
  await run(s, ["[happy] Hello there everyone, and more words."]);
  assert.equal(s.bus.of("brain.say").length, 0);
  assert.equal(s.bus.of("brain.clause").length, 0);
  assert.equal(s.statuses().at(-1), "muted");
});

// @spec CTX-GATE-006
test("a line from someone else that starts during the critic drops the first clause and publishes speaking", async () => {
  const s = setup({ critic: async () => { await other(s.cortex); return { ok: true }; } });
  await run(s, ["[happy] Hello there everyone, and more words."]);
  assert.equal(s.bus.of("brain.say").length, 0);
  assert.equal(s.statuses().at(-1), "speaking");
});

// @spec CTX-GATE-013, CTX-REPEAT-001, CTX-STREAM-021
test("on a later clause the repetition check runs before the re-check: a repeat that is also busy cuts as repeat", async () => {
  const s = setup({ cfg: { repeat_similarity: 0.9 } });
  s.cortex.ctx.pushSelf("the quick brown fox jumps over the lazy dog", "neutral", Date.now(), "old");
  const g = gate();
  s.llm.plans.push({ steps: ["[happy] the quick brown fox jumps, ", { gate: g.promise }, "over the lazy dog."] });
  const thinking = s.cortex.think(mention());
  await waitFor(() => s.bus.of("brain.say").length === 1, "first clause");
  await other(s.cortex); // busy as well
  g.open();
  await thinking;
  assert.deepEqual(s.closings().map((c) => [c.text, c.cut, c.through, c.seq]), [["", "repeat", 0, 1]]);
});

// ---- repetition (CTX-REPEAT-001, 002, 010, 011) ----

// @spec CTX-REPEAT-001, CTX-STREAM-021, CTX-STREAM-025, CTX-STREAM-026, CTX-STREAM-028
test("the repetition check reads the reply so far: a later clause that makes it a repeat is not published and the line closes cut repeat", async () => {
  const s = setup({ cfg: { repeat_similarity: 0.9 } });
  s.cortex.ctx.pushSelf("the quick brown fox jumps over the lazy dog", "neutral", Date.now(), "old");
  await run(s, ["[happy] the quick brown fox jumps, over the lazy dog."]);
  assert.equal(s.bus.of("brain.say")[0]!.text, "the quick brown fox jumps,");
  assert.equal(s.bus.of("brain.say")[0]!.more, true);
  assert.deepEqual(J(s.bus.of("brain.clause")), [{ id: s.bus.of("brain.say")[0]!.id, seq: 1, text: "", last: true, cut: "repeat", through: 0 }]);
});

// @spec CTX-REPEAT-002, CTX-STREAM-034
test("the repetition check leaves out the line being streamed, and compares against a line of any source", async () => {
  const own = setup({ cfg: { repeat_similarity: 0.5 } });
  await run(own, ["[happy] Hello there everyone, welcome to the stream today, enjoy it."]);
  assert.equal(own.closings().length, 1);
  assert.equal(own.closings()[0]!.cut, undefined, "the line's own earlier clauses are not a repeat");
  assert.equal(clauseTexts(own).length, 2);

  const s = setup();
  await s.cortex.onEvent(event("brain.say", { id: "op", text: "Hello there everyone, welcome in.", emotion: "neutral" }, "dashboard"));
  await endOther(s.cortex, "op");
  await run(s, ["[happy] Hello there everyone welcome in."]);
  assert.equal(s.bus.of("brain.say").length, 0, "an operator line counts as a recent line");
});

// @spec CTX-REPEAT-001, CTX-PROMPT-005
test("llm critic: the repetition check runs once, on the whole reply, before any clause is published", async () => {
  const s = setup({ kind: "llm" });
  s.cortex.ctx.pushSelf("the quick brown fox jumps over the lazy dog", "neutral", Date.now(), "old");
  await run(s, ["[happy] the quick brown fox jumps, over the lazy dog."]);
  assert.equal(s.criticCalls.length, 1);
  assert.equal(s.bus.of("brain.say").length, 0, "a repeat of the whole reply publishes no first clause");
  assert.equal(s.bus.of("brain.clause").length, 0);
});

// @spec CTX-REPEAT-010, CTX-REPEAT-011, CTX-GATE-012
test("a repeat on the first clause is the no-line exit and keeps the viewer note for the next think", async () => {
  const s = setup();
  await s.cortex.onEvent(event("memory.viewer", { user: "bob", platform: "twitch", userId: "u1", isNew: true, msgCount: 1, regular: false }));
  s.cortex.ctx.pushSelf("Hello there everyone, welcome in.", "neutral", Date.now(), "old");
  await run(s, ["[happy] Hello there everyone welcome in."]);
  assert.equal(s.bus.of("brain.say").length, 0);
  assert.equal(s.statuses().at(-1), "idle");
  await run(s, ["[happy] Something quite different, honestly."]);
  assert.match(s.llm.system(1), /bob is new here/);
});

// @spec CTX-REPEAT-011
test("a repeat on the first clause keeps the pending glitch for the next think", async () => {
  const s = setup();
  await run(s, ["[happy] The intended line goes right here."]);
  const first = s.bus.of("brain.say")[0]!;
  await s.cortex.onEvent(event("voice.failed", { id: first.id, seq: 0, sink: "d", reason: "tts down", fallback: { clip: "c1", text: "my mic died" } }));
  await s.cortex.onEvent(event("voice.done", { id: first.id, seq: 0, sink: "d" }));
  await run(s, ["[happy] my mic died"]); // a repeat of the fallback line that played
  assert.equal(s.bus.of("brain.say").length, 1, "the repeat published nothing");
  await run(s, ["[happy] A completely fresh thought entirely."]);
  assert.match(s.llm.system(-1), /Your voice glitched/);
});

// ---- cuts and closing (CTX-STREAM-021 to 029) ----

// @spec CTX-STREAM-022, CTX-STREAM-025, CTX-STREAM-026, CTX-STREAM-028
test("muted at the re-check of a later clause: not published, line closed cut muted, stream aborted", async () => {
  const s = setup();
  const g = gate();
  s.llm.plans.push({ steps: ["[happy] First clause is here, ", { gate: g.promise }, "second clause words. and a third one."] });
  const thinking = s.cortex.think(mention());
  await waitFor(() => s.bus.of("brain.say").length === 1, "first clause");
  await s.cortex.onEvent(event("control", { cmd: "mute" }));
  g.open();
  await thinking;
  assert.deepEqual(J(s.bus.of("brain.clause")), [{ id: s.bus.of("brain.say")[0]!.id, seq: 1, text: "", last: true, cut: "muted", through: 0 }]);
  assert.equal(s.llm.endedAborted[0], true, "the stream is aborted before the closing event");
});

// @spec CTX-STREAM-023, CTX-STREAM-026, CTX-STREAM-028
test("another line pending at the re-check of a later clause: closed cut busy; the reply's own line is not busy", async () => {
  const s = setup();
  const g = gate();
  s.llm.plans.push({ steps: ["[happy] First clause is here, ", { gate: g.promise }, "second clause words. and a third one."] });
  const thinking = s.cortex.think(mention());
  await waitFor(() => s.bus.of("brain.say").length === 1, "first clause");
  assert.equal(s.bus.of("brain.clause").length, 0, "its own pending line did not stop anything");
  await other(s.cortex);
  g.open();
  await thinking;
  assert.deepEqual(s.closings().map((c) => [c.text, c.cut, c.through]), [["", "busy", 0]]);
});

// @spec CTX-STREAM-023
test("an operator say counts as someone else's line at the re-check", async () => {
  const s = setup();
  const g = gate();
  s.llm.plans.push({ steps: ["[happy] First clause is here, ", { gate: g.promise }, "second clause words. and a third one."] });
  const thinking = s.cortex.think(mention());
  await waitFor(() => s.bus.of("brain.say").length === 1, "first clause");
  await s.cortex.onEvent(event("control", { cmd: "say", text: "brb" }));
  g.open();
  await thinking;
  assert.deepEqual(s.closings().map((c) => c.cut), ["busy"]);
});

// @spec CTX-STREAM-024, CTX-STREAM-025, CTX-STREAM-033
test("a clause whose seq would reach max_clauses is not published: the line closes cut length", async () => {
  const s = setup({ cfg: { max_clauses: 3 } });
  await run(s, ["[happy] One is here, two is here, three is here, four is here, five is here."]);
  assert.deepEqual(s.line().map((e) => e.text), ["One is here,", "two is here,", "three is here,", ""]);
  assert.deepEqual(s.closings().map((c) => [c.seq, c.cut, c.through]), [[3, "length", 2]]);
  assert.equal(s.llm.endedAborted[0], true);
});

// @spec CTX-STREAM-027, CTX-STREAM-028
test("a stream that ends with nothing left closes with empty text, last, no cut and through the last clause", async () => {
  const s = setup();
  await run(s, ["[happy] First clause is here, second clause is here, "]);
  assert.deepEqual(J(s.line().map((e) => [e.text, e.seq ?? null, e.last ?? null, e.cut ?? null, e.through ?? null])), [
    ["First clause is here,", null, null, null, null],
    ["second clause is here,", 1, null, null, null],
    ["", 2, true, null, 1],
  ]);
  assert.equal(s.closings().length, 1);
});

// @spec CTX-STREAM-027
test("text left when the stream ends that fails its checks is not published: the closing event is empty", async () => {
  const s = setup({ cfg: { repeat_similarity: 0.9 } });
  s.cortex.ctx.pushSelf("the quick brown fox jumps over the lazy dog", "neutral", Date.now(), "old");
  await run(s, ["[happy] the quick brown fox jumps, ", "over the lazy dog"]);
  assert.deepEqual(s.closings().map((c) => [c.text, c.cut, c.through]), [["", "repeat", 0]]);
});

// @spec CTX-STREAM-029, CTX-STREAM-002
test("the think is in flight until its reply closes; the thinking flag is clear after, so a pending line answers speaking", async () => {
  const s = setup();
  const g = gate();
  s.llm.plans.push({ steps: ["[happy] First clause is here, ", { gate: g.promise }, "and the rest."] });
  const thinking = s.cortex.think(mention());
  await waitFor(() => s.bus.of("brain.say").length === 1, "first clause");
  await s.cortex.think(mention()); // a second focus while the reply is still open
  assert.equal(s.statuses().at(-1), "thinking", "still thinking until the reply closes");
  assert.equal(s.llm.calls.length, 1);
  g.open();
  await thinking;
  assert.equal(s.closings().length, 1);
  await s.cortex.think(mention());
  assert.equal(s.statuses().at(-1), "speaking", "the flag is clear: it is the pending line, not a think, that holds it");
  assert.equal(s.llm.calls.length, 1);
});

// @spec CTX-STREAM-029, CTX-GATE-012
test("a think that ends without a line clears the thinking flag", async () => {
  const s = setup();
  await run(s, ["   "]);
  await run(s, ["[happy] Hello there everyone, welcome in."]);
  assert.equal(s.llm.calls.length, 2, "the second focus started a think");
  assert.equal(s.bus.of("brain.say").length, 1);
});

// @spec CTX-SAY-004
test("no new think starts while a line of its own is pending, streaming or not", async () => {
  const s = setup();
  const g = gate();
  s.llm.plans.push({ steps: ["[happy] First clause is here, ", { gate: g.promise }, "and the rest."] });
  const thinking = s.cortex.think(mention());
  await waitFor(() => s.bus.of("brain.say").length === 1, "first clause");
  await s.cortex.think(mention());
  assert.equal(s.llm.calls.length, 1);
  g.open();
  await thinking;
  await s.cortex.think(mention());
  assert.equal(s.llm.calls.length, 1, "the closed reply's line is still pending");
});

// ---- the no-line exits (CTX-GATE-012, CTX-PROMPT-006 path, CTX-STREAM-032) ----

// @spec CTX-GATE-012
test("a think that ends without a line publishes idle, muted when muted, speaking while another line plays", async () => {
  const idle = setup();
  await run(idle, ["  "]);
  assert.equal(idle.bus.of("brain.say").length, 0);
  assert.equal(idle.statuses().at(-1), "idle");

  const muted = setup();
  const g = gate();
  muted.llm.plans.push({ steps: [{ gate: g.promise }, "x"] });
  const m = muted.cortex.think(mention());
  await waitFor(() => muted.llm.calls.length === 1, "stream");
  await muted.cortex.onEvent(event("control", { cmd: "mute" }));
  g.open();
  await m;
  assert.equal(muted.statuses().at(-1), "muted");

  const busy = setup();
  const g2 = gate();
  busy.llm.plans.push({ steps: [{ gate: g2.promise }, "x"] });
  const b = busy.cortex.think(mention());
  await waitFor(() => busy.llm.calls.length === 1, "stream");
  await other(busy.cortex);
  g2.open();
  await b;
  assert.equal(busy.statuses().at(-1), "speaking");
});

// @spec CTX-GATE-012, CTX-CRITIC-001
test("a critic veto and a failed re-check end the think with the same status rule", async () => {
  const vetoed = setup({ critic: async () => { await other(vetoed.cortex); return { ok: false, note: "no" }; } });
  await run(vetoed, ["[happy] Hello there everyone, and more."]);
  assert.equal(vetoed.bus.of("brain.say").length, 0);
  assert.equal(vetoed.statuses().at(-1), "speaking");
});

// @spec CTX-STREAM-032, CTX-GATE-012
test("finish refusal with nothing published ends the think without a line", async () => {
  const s = setup();
  await run(s, [], "refusal");
  assert.equal(s.bus.of("brain.say").length, 0);
  assert.equal(s.statuses().at(-1), "idle");
  assert.equal(s.llm.calls.length, 1, "the reply was read from llm.stream");
});

// @spec CTX-STREAM-032
test("finish refusal after a clause was published closes the reply normally", async () => {
  const s = setup();
  await run(s, ["[happy] First clause is here, and then the model stops."], "refusal");
  assert.equal(s.bus.of("brain.say")[0]!.text, "First clause is here,");
  assert.deepEqual(s.closings().map((c) => [c.text, c.cut, c.through]), [["and then the model stops.", undefined, 1]]);
});

// ---- the think in flight (CTX-GATE-010) ----

// @spec CTX-GATE-010
test("a voice.stop does not cancel a think that has no clause yet: it completes and publishes its line", async () => {
  const s = setup();
  const g = gate();
  s.llm.plans.push({ steps: [{ gate: g.promise }, "[happy] Hello there everyone, welcome in."] });
  const thinking = s.cortex.think(mention());
  await waitFor(() => s.llm.calls.length === 1, "stream");
  await s.cortex.onEvent(event("voice.stop", { reason: "operator" }));
  assert.equal(s.llm.calls.length, 1, "no think started for the stop");
  assert.equal(s.llm.opts[0]!.signal!.aborted, false, "the stream was not aborted");
  g.open();
  await thinking;
  assert.equal(s.bus.of("brain.say").length, 1);
  assert.equal(s.llm.calls.length, 1);
});

// ---- timing (CTX-SAY-007) ----

// @spec CTX-SAY-007
test("rules critic: llmEndedAt is the time the first clause was cut, before the stream ends", async () => {
  const s = setup();
  const g = gate();
  s.llm.plans.push({ steps: ["[happy] First clause is here, ", { gate: g.promise }, "and the rest."] });
  const thinking = s.cortex.think(mention());
  await waitFor(() => s.bus.of("brain.say").length === 1, "first clause");
  await new Promise((r) => setTimeout(r, 30));
  const released = Date.now();
  g.open();
  await thinking;
  const t = s.bus.of("brain.say")[0]!.timing!;
  assert.ok(t.llmStartedAt! <= t.llmEndedAt!);
  assert.ok(t.llmEndedAt! < released, `llmEndedAt ${t.llmEndedAt} is before the stream ended at ${released}`);
});

// @spec CTX-SAY-007
test("llm critic: llmEndedAt is the time the whole reply was in hand", async () => {
  const s = setup({ kind: "llm" });
  const g = gate();
  s.llm.plans.push({ steps: ["[happy] First clause is here, ", { gate: g.promise }, "and the rest."] });
  const thinking = s.cortex.think(mention());
  await waitFor(() => s.llm.calls.length === 1, "stream");
  await new Promise((r) => setTimeout(r, 30));
  const released = Date.now();
  g.open();
  await thinking;
  const t = s.bus.of("brain.say")[0]!.timing!;
  assert.ok(t.llmEndedAt! >= released, `llmEndedAt ${t.llmEndedAt} is at or after the stream's end ${released}`);
});

// ---- working memory and configuration (CTX-STREAM-033, 034) ----

// @spec CTX-STREAM-034
test("its own brain.clause read back extends the working-memory line; a clause for a line no longer held changes nothing", async () => {
  const s = setup();
  await run(s, ["[happy] First clause is here, second clause is here, and a third."]);
  const self = s.cortex.ctx.all().filter((e) => e.kind === "self");
  assert.equal(self.length, 1);
  assert.equal(self[0]!.kind === "self" && self[0]!.text, "First clause is here, second clause is here, and a third.");
  const before = JSON.stringify(s.cortex.ctx.all());
  await s.cortex.onEvent(event("brain.clause", { id: "gone", seq: 1, text: "orphan clause" }, "cortex"));
  assert.equal(JSON.stringify(s.cortex.ctx.all()), before);
});

// ---- the stream call (CTX-STREAM-026, CTX-HEALTH-003 at the call site) ----

// @spec CTX-STREAM-026, CTX-STREAM-002
test("the reply is read with llm.stream under an AbortSignal and no per-call options besides signal and tools", async () => {
  const s = setup();
  await run(s, ["[happy] Hello there everyone, welcome in."]);
  assert.equal(s.llm.calls.length, 1);
  assert.ok(s.llm.opts[0]!.signal instanceof AbortSignal);
  assert.deepEqual(Object.keys(s.llm.opts[0]!).filter((k) => k !== "signal" && s.llm.opts[0]![k as keyof ChatRequest] !== undefined), []);
});

// ---- shutdown (CTX-STREAM-037) ----

// @spec CTX-STREAM-037, CTX-STREAM-028
test("stop() closes a streamed line whose reply had not closed with cut stopped, once", async () => {
  const s = setup();
  const g = gate();
  s.llm.plans.push({ steps: ["[happy] First clause is here, ", { gate: g.promise }, "and the rest."] });
  const thinking = s.cortex.think(mention());
  await waitFor(() => s.bus.of("brain.say").length === 1, "first clause");
  await s.cortex.stop();
  assert.deepEqual(s.closings().map((c) => [c.text, c.cut, c.through, c.seq]), [["", "stopped", 0, 1]]);
  g.open();
  await thinking;
  assert.equal(s.closings().length, 1, "exactly one closing event");
  assert.equal(s.bus.of("brain.clause").length, 1);
});

// @spec CTX-STREAM-037
test("stop() publishes nothing for a line whose reply already closed or that had no more", async () => {
  const s = setup();
  await run(s, ["[happy] Just one short line here."]);
  assert.equal(s.bus.of("brain.say").length, 1);
  await s.cortex.stop();
  assert.equal(s.bus.of("brain.clause").length, 0);
  const t = setup();
  await run(t, ["[happy] First clause is here, and the rest."]);
  const before = t.bus.of("brain.clause").length;
  await t.cortex.stop();
  assert.equal(t.bus.of("brain.clause").length, before);
});
