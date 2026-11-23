import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { ModuleSchema } from "@cohost/config";
import { Module } from "@cohost/modules";
import type { ChatEvent, ChatMessage, ChatProvider, ChatRequest, ChatResult } from "@cohost/llm";
import type { EventInput, EventType } from "@cohost/bus";
import { FakeBus, event, silentLog, testConfig, waitFor } from "@cohost/testing";
import { Cortex } from "../src/cortex.js";
import type { CriticInput, CriticOutput } from "../src/critic.js";

// Releasing, failing and stopping a streamed line (cortex-design.md, Releasing a streamed line, Stopping its own line on a
// mute or pause). Sinks are scripted: each test feeds the cortex the `voice.*` events a sink would publish.

type Step = string | { gate: Promise<void> } | { fail: Error };

const gate = () => {
  let open!: () => void;
  const promise = new Promise<void>((r) => { open = r; });
  return { promise, open };
};

class StreamLlm implements ChatProvider {
  readonly name = "fake";
  readonly model = "fake";
  plans: Step[][] = [];
  calls: ChatMessage[][] = [];
  endedAborted: boolean[] = [];
  async chat(): Promise<string> { throw new Error("the reply must be read with stream()"); }
  async complete(): Promise<ChatResult> { throw new Error("the reply must be read with stream()"); }
  async ping() { return true; }
  async *stream(msgs: ChatMessage[], opts?: ChatRequest): AsyncGenerator<ChatEvent> {
    const n = this.calls.length;
    this.calls.push(msgs);
    const steps = this.plans[n] ?? ["[happy] hey chat!"];
    let text = "";
    try {
      for (const step of steps) {
        if (opts?.signal?.aborted) throw opts.signal.reason ?? new Error("aborted");
        if (typeof step === "string") { text += step; yield { type: "text", delta: step }; continue; }
        if ("fail" in step) throw step.fail;
        await step.gate;
      }
      if (opts?.signal?.aborted) throw opts.signal.reason ?? new Error("aborted");
      yield { type: "done", result: { text, toolCalls: [], finish: "stop", message: { role: "assistant", content: text } } };
    } finally {
      this.endedAborted[n] = opts?.signal?.aborted ?? false;
    }
  }
  system(i = -1) { return this.calls.at(i)![0]!.content; }
}

/** A bus that hands the cortex its own `brain.say`, `brain.clause` and `voice.stop` back, as the real bus does. */
class LoopBus extends FakeBus {
  cortex?: Cortex;
  override async publish<T extends EventType>(type: T, data: EventInput<T>): Promise<string> {
    const id = await super.publish(type, data);
    if (type === "brain.say" || type === "brain.clause" || type === "voice.stop") await this.cortex?.onEvent(event(type, data, "cortex"));
    return id;
  }
}

function setup(cfg: Record<string, unknown> = {}) {
  const config = testConfig({ brain: { memory: { recall_k: 0 }, cortex: { recall_timeout_ms: 100, clause_min_chars: 10, clause_max_chars: 60, max_clauses: 8, ...cfg } } });
  const bus = new LoopBus();
  const llm = new StreamLlm();
  const critic = new Module<CriticInput, CriticOutput>("critic", ModuleSchema.parse({}), {} as never, { rules: () => ({ ok: true }) }, silentLog);
  const cortex = new Cortex({ cfg: config, bus, llm, critic, log: silentLog, loadPersonality: () => "You are Coco." });
  bus.cortex = cortex;
  return {
    bus, llm, cortex,
    statuses: () => bus.of("brain.status").map((s) => s.state),
    closings: () => bus.of("brain.clause").filter((c) => c.last),
  };
}
type S = ReturnType<typeof setup>;

const mention = () => ({ reason: "mentioned", score: 1, focus: { kind: "chat" as const, who: "bob", text: "hey Coco, how are you?", mention: true } });
const TWO = ["[happy] First clause is here, second clause is here."];
const THREE = ["[happy] First clause is here, second clause is here, third clause is here."];
const FALLBACK = { clip: "c1", text: "my mic died" };

const utt = (id: string, seq = 0) => event("voice.utterance", { id, seq, text: "x", emotion: "neutral", durationMs: 1000, envelopeHz: 50, envelope: [], audioUrl: `/audio/${id}-${seq}.wav`, sampleRate: 24000, ...(seq === 0 ? { more: true } : {}) } as never);
const playing = (id: string, seq: number, sink: string) => event("voice.playing", { id, seq, sink });
const done = (id: string, seq: number, sink: string, extra: Record<string, unknown> = {}) => event("voice.done", { id, seq, sink, ...extra } as never);
const failed = (id: string, seq: number, sink: string, fallback?: { clip: string; text: string }) =>
  event("voice.failed", { id, seq, sink, reason: "tts down", ...(fallback ? { fallback } : {}) });
const stop = (ids?: string[]) => event("voice.stop", { reason: "barge-in", ...(ids ? { ids } : {}) });
const control = (cmd: "mute" | "pause" | "unmute" | "resume") => event("control", { cmd });
const reflex = (cortex: Cortex, id: string, source = "salience") => cortex.onEvent(event("brain.say", { id, text: "a reflex line", emotion: "neutral" }, source));

/** A think over a scripted reply, run to the end; returns the line's id. */
async function closedLine(s: S, steps: Step[] = TWO): Promise<string> {
  s.llm.plans.push(steps);
  await s.cortex.think(mention());
  return s.bus.of("brain.say").at(-1)!.id;
}

/** A think whose reply stays open: clause 0 is published, the stream waits on the gate, then `rest` arrives. */
async function openLine(s: S, rest: Step[] = ["second clause is here."]) {
  const g = gate();
  s.llm.plans.push(["[happy] First clause is here, ", { gate: g.promise }, ...rest]);
  const thinking = s.cortex.think(mention());
  await waitFor(() => s.bus.of("brain.say").length === 1, "clause 0");
  return { id: s.bus.of("brain.say")[0]!.id, thinking, g };
}

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
/** Fake `setTimeout` and `Date` for the body, then restore them. */
async function withTimers(body: (tick: (ms: number) => Promise<void>) => Promise<void>): Promise<void> {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    await body(async (ms) => { mock.timers.tick(ms); await flush(); });
  } finally {
    mock.timers.reset();
  }
}
const idles = (s: S) => s.statuses().filter((x) => x === "idle").length;
const selfEntry = (s: S, id: string) => s.cortex.ctx.all().find((e) => e.kind === "self" && e.id === id) as { text: string; heard?: string; fallback?: string } | undefined;
/** The cortex is busy when a focus is answered `speaking` with no model call. */
async function busy(s: S): Promise<boolean> {
  const calls = s.llm.calls.length;
  await s.cortex.think(mention());
  return s.llm.calls.length === calls && s.statuses().at(-1) === "speaking";
}

// ---- release by completion (CTX-REL-002 to 006, 008, CTX-STREAM-001) ----

// @spec CTX-STREAM-001, CTX-REL-002, CTX-REL-003, CTX-REL-006
test("a streamed line stays pending after its think ends and is released when its one player has done the last clause", async () => {
  const s = setup();
  const id = await closedLine(s);
  assert.equal(s.bus.of("brain.say")[0]!.more, true);
  await s.cortex.onEvent(utt(id));
  await s.cortex.onEvent(playing(id, 0, "A"));
  await s.cortex.onEvent(done(id, 0, "A")); // clause 0 is not the last produced clause
  assert.equal(idles(s), 0, "no idle while the line is pending");
  assert.ok(await busy(s), "the line is still pending after clause 0 finished");
  await s.cortex.onEvent(done(id, 1, "A"));
  assert.equal(s.statuses().at(-1), "idle");
  assert.equal(idles(s), 1);
});

// @spec CTX-STREAM-001
test("a line without more is released by the first voice.done of its clause, whatever other sinks play", async () => {
  const s = setup();
  const id = await closedLine(s, ["[happy] Just one short line here."]);
  assert.equal(s.bus.of("brain.say")[0]!.more, undefined);
  await s.cortex.onEvent(playing(id, 0, "A"));
  await s.cortex.onEvent(playing(id, 0, "B"));
  await s.cortex.onEvent(done(id, 0, "A"));
  assert.equal(s.statuses().at(-1), "idle");
});

// @spec CTX-REL-003, CTX-REL-006
for (const flag of ["final", "interrupted"] as const) {
  test(`a ${flag} voice.done completes a player at any clause`, async () => {
    const s = setup();
    const id = await closedLine(s);
    await s.cortex.onEvent(playing(id, 0, "A"));
    await s.cortex.onEvent(done(id, 0, "A", { [flag]: true }));
    assert.equal(s.statuses().at(-1), "idle");
  });
}

// @spec CTX-REL-008, CTX-REL-002
test("a final done from one sink does not release the line while another player has not completed it", async () => {
  const s = setup();
  const id = await closedLine(s);
  await s.cortex.onEvent(playing(id, 0, "A"));
  await s.cortex.onEvent(playing(id, 0, "B"));
  await s.cortex.onEvent(done(id, 0, "A", { final: true }));
  assert.equal(idles(s), 0);
  assert.ok(await busy(s));
  await s.cortex.onEvent(done(id, 1, "B"));
  assert.equal(s.statuses().at(-1), "idle");
});

// @spec CTX-REL-004, CTX-REL-006
test("a final done from the sink error for clause k lowers the last produced clause to k minus 1", async () => {
  const s = setup();
  const id = await closedLine(s); // clauses 0 and 1
  await s.cortex.onEvent(playing(id, 0, "A"));
  await s.cortex.onEvent(done(id, 1, "error", { final: true }));
  assert.equal(idles(s), 0, "A has not completed clause 0 yet");
  await s.cortex.onEvent(done(id, 0, "A")); // clause 0 is now the last produced clause
  assert.equal(s.statuses().at(-1), "idle");
});

// @spec CTX-REL-005, CTX-REL-006
test("a player that completed the last produced clause is judged again when a further clause is published", async () => {
  const s = setup();
  const { id, thinking, g } = await openLine(s);
  await s.cortex.onEvent(playing(id, 0, "A"));
  await s.cortex.onEvent(done(id, 0, "A")); // completed: clause 0 is the last produced clause
  g.open();
  await thinking; // clause 1 published and the reply closed
  assert.ok(await busy(s), "clause 1 is not completed any longer");
  await s.cortex.onEvent(done(id, 1, "A"));
  assert.equal(s.statuses().at(-1), "idle");
});

// ---- status after release (CTX-REL-009, CTX-REL-010, CTX-EVT-005, CTX-SAY-005) ----

// @spec CTX-REL-010, CTX-EVT-005
test("a think that ends while its line is pending publishes no status; a done during the think publishes none either", async () => {
  const s = setup();
  const { id, thinking, g } = await openLine(s);
  await s.cortex.onEvent(playing(id, 0, "A"));
  await s.cortex.onEvent(done(id, 0, "A"));
  assert.equal(idles(s), 0, "no status for a done while a think is in flight");
  g.open();
  await thinking;
  assert.equal(s.closings().length, 1);
  assert.equal(idles(s), 1, "the reply closed with every player complete: one idle");
});

// @spec CTX-REL-010
test("a think that ends while a player has not completed publishes no status after its speaking", async () => {
  const s = setup();
  await closedLine(s);
  assert.deepEqual(s.statuses(), ["thinking", "speaking"]);
});

// @spec CTX-SAY-005, CTX-REL-009
test("an operator say over a streamed line keeps both pending: idle only after the streamed line and the operator line end", async () => {
  const s = setup();
  const id = await closedLine(s);
  await s.cortex.onEvent(playing(id, 0, "A"));
  await s.cortex.onEvent(event("control", { cmd: "say", text: "operator words" }));
  const op = s.bus.of("brain.say").find((x) => x.reason === "operator")!;
  await s.cortex.onEvent(done(id, 1, "A"));
  assert.equal(idles(s), 0, "the operator line is still pending");
  await s.cortex.onEvent(done(op.id, 0, "A"));
  assert.equal(s.statuses().at(-1), "idle");
});

// ---- failure: clause 0, error final, claim window (CTX-REL-007, 011 to 015, CTX-FALL-012) ----

// @spec CTX-FALL-012, CTX-REL-015
test("an error final for clause 0 on an open reply closes the line failed through 0, aborts the stream and marks it heard by nobody", async () => {
  const s = setup();
  const { id, thinking, g } = await openLine(s);
  await s.cortex.onEvent(done(id, 0, "error", { final: true }));
  assert.deepEqual(s.closings().map((c) => [c.text, c.cut, c.through, c.seq]), [["", "failed", 0, 1]]);
  g.open();
  await thinking;
  assert.equal(s.llm.endedAborted[0], true);
  assert.equal(s.bus.of("brain.clause").length, 1, "no clause after the closing one");
  assert.equal(selfEntry(s, id)!.heard, "");
  assert.equal(s.statuses().at(-1), "idle");
  await s.cortex.think(mention());
  assert.doesNotMatch(s.llm.system(), /Your voice glitched/, "no glitch is kept");
});

// @spec CTX-REL-015
test("an error final for clause k closes the line failed through k minus 1", async () => {
  const s = setup();
  const g = gate();
  s.llm.plans.push(["[happy] First clause is here, second clause is here, ", { gate: g.promise }, "third clause."]);
  const thinking = s.cortex.think(mention());
  await waitFor(() => s.bus.of("brain.clause").length === 1, "clause 1");
  const id = s.bus.of("brain.say")[0]!.id;
  await s.cortex.onEvent(done(id, 1, "error", { final: true }));
  assert.deepEqual(s.closings().map((c) => [c.cut, c.through, c.seq]), [["failed", 0, 2]]);
  g.open();
  await thinking;
  assert.equal(s.bus.of("brain.clause").length, 2);
});

// @spec CTX-REL-007, CTX-FALL-012
test("an error final for clause 0 after the reply closed releases the line and marks it heard by nobody", async () => {
  const s = setup();
  const id = await closedLine(s);
  await s.cortex.onEvent(done(id, 0, "error", { final: true }));
  assert.equal(s.statuses().at(-1), "idle");
  assert.equal(selfEntry(s, id)!.heard, "");
});

// @spec CTX-REL-011, CTX-REL-012, CTX-REL-013
test("with no player the claim window runs 1500 ms from the first voice.utterance read, and the line then closes failed", async () => {
  const s = setup();
  const { id, thinking, g } = await openLine(s);
  await withTimers(async (tick) => {
    await tick(1000); // publication to utterance: the window has not started
    await s.cortex.onEvent(utt(id));
    await tick(100);
    await s.cortex.onEvent(failed(id, 0, "A"));
    await tick(1399); // 1499 ms after the utterance
    assert.equal(s.closings().length, 0, "the window has not ended");
    await tick(1);
    assert.deepEqual(s.closings().map((c) => [c.cut, c.through]), [["failed", 0]]);
  });
  g.open();
  await thinking;
  assert.equal(s.llm.endedAborted[0], true);
  assert.equal(s.statuses().at(-1), "idle");
});

// @spec CTX-REL-012, CTX-REL-013
test("with a player the failure condition needs every player ended and the window over: a final before the window ends cuts when it ends", async () => {
  const s = setup();
  const { id, thinking, g } = await openLine(s);
  await withTimers(async (tick) => {
    await s.cortex.onEvent(utt(id));
    await s.cortex.onEvent(playing(id, 0, "A"));
    await tick(200);
    await s.cortex.onEvent(done(id, 0, "A", { final: true }));
    assert.equal(s.closings().length, 0, "inside the claim window");
    await tick(1299);
    assert.equal(s.closings().length, 0);
    await tick(1);
    assert.deepEqual(s.closings().map((c) => [c.cut, c.through]), [["failed", 0]]);
  });
  g.open();
  await thinking;
});

// @spec CTX-REL-012, CTX-REL-013
test("a failure read after the window has ended closes the line failed at once when every player has ended", async () => {
  const s = setup();
  const { id, thinking, g } = await openLine(s);
  await withTimers(async (tick) => {
    await s.cortex.onEvent(utt(id));
    await s.cortex.onEvent(playing(id, 0, "A"));
    await tick(1500);
    assert.equal(s.closings().length, 0, "nobody has failed yet");
    await s.cortex.onEvent(failed(id, 0, "A", FALLBACK));
    assert.deepEqual(s.closings().map((c) => c.cut), ["failed"]);
  });
  g.open();
  await thinking;
});

// @spec CTX-REL-014, CTX-REL-012
test("a final from one sink while another still plays cuts nothing: the reply keeps being published", async () => {
  const s = setup();
  const { id, thinking, g } = await openLine(s);
  await withTimers(async (tick) => {
    await s.cortex.onEvent(utt(id));
    await s.cortex.onEvent(playing(id, 0, "A"));
    await s.cortex.onEvent(playing(id, 0, "B"));
    await tick(1500);
    await s.cortex.onEvent(done(id, 0, "A", { final: true }));
    await s.cortex.onEvent(failed(id, 0, "A"));
  });
  assert.equal(s.closings().length, 0);
  g.open();
  await thinking;
  assert.deepEqual(s.bus.of("brain.clause").map((c) => [c.seq, c.text, c.cut]), [[1, "second clause is here.", undefined]]);
  assert.equal(s.llm.endedAborted[0], false);
});

// @spec CTX-REL-007, CTX-REL-011, CTX-REL-012
test("a closed reply nobody plays is released once the window has ended and a failure has been read", async () => {
  const s = setup();
  const id = await closedLine(s);
  await withTimers(async (tick) => {
    await s.cortex.onEvent(utt(id));
    await s.cortex.onEvent(failed(id, 0, "A"));
    await tick(1499);
    assert.equal(idles(s), 0);
    await tick(1);
    assert.equal(s.statuses().at(-1), "idle");
  });
  assert.equal(s.closings().length, 1, "the reply had closed: no second closing event");
});

// @spec CTX-STREAM-031
test("a stream that fails after a clause was published closes the line cut failed and speaks no fallback or repair", async () => {
  const s = setup();
  s.llm.plans.push(["[happy] First clause is here, ", { fail: new Error("backend gone") }]);
  await s.cortex.think(mention());
  assert.equal(s.bus.of("brain.say").length, 1);
  assert.deepEqual(s.closings().map((c) => [c.text, c.cut, c.through, c.seq]), [["", "failed", 0, 1]]);
  assert.equal(s.llm.calls.length, 1, "no repair call");
  assert.equal(s.bus.of("brain.say").length + s.bus.of("brain.clause").length, 2, "no fallback line");
});

// ---- failed sinks: what is recorded (CTX-REL-016, CTX-FALL-008, 009, 010, 011) ----

// @spec CTX-FALL-008, CTX-FALL-010
test("a voice.failed with a fallback for clause k of a streamed line marks the line from k and keeps a glitch for the rest of it", async () => {
  const s = setup();
  const id = await closedLine(s, THREE);
  await s.cortex.onEvent(failed(id, 1, "A", FALLBACK));
  assert.equal(selfEntry(s, id)!.fallback, "First clause is here, my mic died");
  await s.cortex.onEvent(stop([id]));
  await s.cortex.think(mention());
  const system = s.llm.system();
  assert.match(system, /the rest of your line/);
  assert.match(system, /second clause is here, third clause is here\./);
  assert.doesNotMatch(system, /"[^"]*First clause is here[^"]*"/, "the clause that played is not quoted as failed");
  assert.match(system, /my mic died/);
});

// @spec CTX-REL-016, CTX-FALL-008
test("a voice.failed read while the reply is open applies its mark and glitch once the closing clause is read back", async () => {
  const s = setup();
  const { id, thinking, g } = await openLine(s);
  await s.cortex.onEvent(failed(id, 0, "A", FALLBACK));
  assert.equal(selfEntry(s, id)!.fallback, undefined, "not applied while the reply is open");
  g.open();
  await thinking;
  assert.equal(selfEntry(s, id)!.fallback, "my mic died");
  await s.cortex.onEvent(stop([id]));
  await s.cortex.think(mention());
  assert.match(s.llm.system(), /First clause is here, second clause is here\./, "the glitch holds every clause published from the failed seq on");
});

// @spec CTX-FALL-009
test("a voice.failed for a streamed line that another sink played marks nothing, keeps no glitch and records no heard text", async () => {
  const s = setup();
  const id = await closedLine(s);
  await s.cortex.onEvent(playing(id, 0, "B"));
  await s.cortex.onEvent(failed(id, 1, "A", FALLBACK));
  await s.cortex.onEvent(failed(id, 1, "A"));
  const e = selfEntry(s, id)!;
  assert.equal(e.fallback, undefined);
  assert.equal(e.heard, undefined);
  await s.cortex.onEvent(stop([id]));
  await s.cortex.think(mention());
  assert.doesNotMatch(s.llm.system(), /Your voice glitched/);
});

// @spec CTX-FALL-011
test("a voice.failed without a fallback for a streamed line records the clauses before the failed seq as heard", async () => {
  const s = setup();
  const id = await closedLine(s, THREE);
  await s.cortex.onEvent(failed(id, 2, "A"));
  assert.equal(selfEntry(s, id)!.heard, "First clause is here, second clause is here,");
  assert.ok(await busy(s), "the speaking state is unchanged");
  const t = setup();
  const id2 = await closedLine(t, THREE);
  await t.cortex.onEvent(failed(id2, 0, "A"));
  assert.equal(selfEntry(t, id2)!.heard, "", "the empty string when the failed seq is 0");
});

// ---- the no-progress valve (CTX-GATE-004, CTX-GATE-009, CTX-REL-001, CTX-STREAM-036) ----

// @spec CTX-GATE-004, CTX-GATE-009, CTX-REL-001, CTX-STREAM-036
test("the valve restarts at each progress and closes an open streamed line cut timeout, scheduling no think", async () => {
  const s = setup({ speaking_timeout_ms: 1000 });
  const { id, thinking, g } = await openLine(s);
  await withTimers(async (tick) => {
    await tick(800);
    await s.cortex.onEvent(utt(id)); // progress
    await tick(800); // 1600 ms after the line began, 800 after the progress
    assert.equal(s.closings().length, 0);
    await tick(199);
    assert.equal(s.closings().length, 0);
    await tick(1);
    assert.deepEqual(s.closings().map((c) => [c.text, c.cut, c.through]), [["", "timeout", 0]]);
  });
  g.open();
  await thinking;
  assert.equal(s.llm.endedAborted[0], true);
  assert.equal(s.llm.calls.length, 1, "the timeout invoked no think");
  assert.equal(s.statuses().at(-1), "idle");
  assert.equal(idles(s), 1);
});

// @spec CTX-REL-001, CTX-GATE-004, CTX-GATE-009
test("the valve runs only while a clause is outstanding: a wait on the model is not timed, a clause published after it is progress", async () => {
  const s = setup({ speaking_timeout_ms: 1000 });
  const { id, thinking, g } = await openLine(s);
  await withTimers(async (tick) => {
    await s.cortex.onEvent(playing(id, 0, "A"));
    await s.cortex.onEvent(done(id, 0, "A")); // nothing outstanding
    await tick(5000);
    assert.equal(s.closings().length, 0, "waiting for the model is not timed");
    assert.equal(idles(s), 0);
    g.open(); // clause 1 is published with none outstanding: progress
    await thinking;
    await flush();
    assert.equal(s.closings().length, 1);
    await tick(999);
    assert.equal(idles(s), 0);
    await tick(1);
    assert.equal(s.statuses().at(-1), "idle", "released by the valve once clause 1 saw no progress for the timeout");
  });
});

// ---- voice.stop (CTX-STREAM-035, CTX-EVT-012 is in fallback.test.ts) ----

// @spec CTX-STREAM-035
for (const [name, ids] of [["names the line", (id: string) => [id]], ["carries no ids", () => undefined]] as const) {
  test(`a voice.stop that ${name} closes an open streamed reply cut stopped and aborts the stream`, async () => {
    const s = setup();
    const { id, thinking, g } = await openLine(s);
    await s.cortex.onEvent(stop(ids(id)));
    assert.deepEqual(s.closings().map((c) => [c.text, c.cut, c.through, c.seq]), [["", "stopped", 0, 1]]);
    g.open();
    await thinking;
    assert.equal(s.llm.endedAborted[0], true);
    assert.equal(s.bus.of("brain.clause").length, 1, "nothing after the closing event");
    assert.equal(s.statuses().at(-1), "idle");
    assert.equal(idles(s), 1);
  });
}

// @spec CTX-STREAM-035
test("a voice.stop for another line leaves an open reply running; a stop after the reply closed adds no closing event", async () => {
  const s = setup();
  const { id, thinking, g } = await openLine(s);
  await s.cortex.onEvent(stop(["somebody-else"]));
  assert.equal(s.closings().length, 0);
  g.open();
  await thinking;
  assert.deepEqual(s.bus.of("brain.clause").map((c) => [c.seq, c.cut]), [[1, undefined]]);
  await s.cortex.onEvent(stop([id]));
  assert.equal(s.bus.of("brain.clause").length, 1);
});

// ---- mute and pause stop the cortex's own reply lines (CTX-CTRL-008 to 011, CTX-EVT-013) ----

// @spec CTX-CTRL-008, CTX-CTRL-009, CTX-EVT-013
for (const [cmd, reason] of [["mute", "muted"], ["pause", "paused"]] as const) {
  test(`a ${cmd} over an open streamed reply closes it cut muted, publishes one voice.stop (${reason}) and releases the line`, async () => {
    const s = setup();
    const { id, thinking, g } = await openLine(s);
    await s.cortex.onEvent(control(cmd));
    assert.deepEqual(s.closings().map((c) => [c.text, c.cut, c.through]), [["", "muted", 0]]);
    assert.deepEqual(s.bus.of("voice.stop").map((v) => [v.reason, v.ids]), [[reason, [id]]]);
    const order = s.bus.published.map((p) => p.type).filter((t) => t === "brain.clause" || t === "voice.stop");
    assert.deepEqual(order, ["brain.clause", "voice.stop"], "the closing event first, then the stop");
    g.open();
    await thinking;
    assert.equal(s.llm.endedAborted[0], true);
    assert.equal(s.bus.of("brain.clause").length, 1);
    assert.equal(s.statuses().at(-1), "muted");
    // read back by the cortex itself, the stop released the line: after the resume a focus can think
    await s.cortex.onEvent(control(cmd === "mute" ? "unmute" : "resume"));
    await s.cortex.think(mention());
    assert.equal(s.llm.calls.length, 2);
  });
}

// @spec CTX-CTRL-008, CTX-CTRL-009
test("a mute over a closed streamed reply publishes the stop and no closing event, and a mute over a single-clause reply stops it too", async () => {
  const s = setup();
  const id = await closedLine(s);
  const closings = s.bus.of("brain.clause").length;
  await s.cortex.onEvent(control("mute"));
  assert.equal(s.bus.of("brain.clause").length, closings);
  assert.deepEqual(s.bus.of("voice.stop").map((v) => [v.reason, v.ids]), [["muted", [id]]]);
  const t = setup();
  const one = await closedLine(t, ["[happy] Just one short line here."]);
  await t.cortex.onEvent(control("pause"));
  assert.deepEqual(t.bus.of("voice.stop").map((v) => [v.reason, v.ids]), [["paused", [one]]]);
});

// @spec CTX-CTRL-010, CTX-CTRL-011
test("a mute stops no operator, reflex or foreign line and publishes no voice.stop when no reply line is pending", async () => {
  const s = setup();
  await reflex(s.cortex, "reflex-1");
  await reflex(s.cortex, "foreign-1", "other");
  await s.cortex.onEvent(event("control", { cmd: "say", text: "operator words" }));
  await s.cortex.onEvent(control("mute"));
  assert.equal(s.bus.of("voice.stop").length, 0);
  await s.cortex.onEvent(control("unmute"));
  assert.ok(await busy(s), "the three lines are still pending");
});

// @spec CTX-CTRL-010, CTX-CTRL-009
test("a mute with a reply line and an operator line pending names only the reply line and leaves the operator line pending", async () => {
  const s = setup();
  const id = await closedLine(s);
  await s.cortex.onEvent(event("control", { cmd: "say", text: "operator words" }));
  await s.cortex.onEvent(control("mute"));
  assert.deepEqual(s.bus.of("voice.stop").map((v) => v.ids), [[id]]);
  await s.cortex.onEvent(control("unmute"));
  assert.ok(await busy(s), "the operator line is still pending");
});

// @spec CTX-CTRL-011
test("a pause with a think in flight and no line published yet publishes no voice.stop", async () => {
  const s = setup();
  const g = gate();
  s.llm.plans.push([{ gate: g.promise }, "[happy] Hello there everyone, welcome in."]);
  const thinking = s.cortex.think(mention());
  await waitFor(() => s.llm.calls.length === 1, "stream");
  await s.cortex.onEvent(control("pause"));
  g.open();
  await thinking;
  assert.equal(s.bus.of("voice.stop").length, 0);
  assert.equal(s.bus.of("brain.say").length, 0);
});
