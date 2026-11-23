import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeBus, event, recordingLog } from "@cohost/testing";
import { MOUTH_LOOP_TYPES, createMouthHandler } from "../src/session.js";
import { ClaimMemory, FallbackLine } from "../src/fallback.js";
import { ClipCache } from "../src/clips.js";

// The loop handler for streamed lines (MOUTH-PLAY-001, MOUTH-ROUTE-003, 008, MOUTH-LIVE-002, MOUTH-FALL-010).
//
// Seams the code phase provides (named here, adjustable by the code phase):
//   - MouthOutput.playback.enqueue(id, url, utt: { text, durationMs, seq, more? })
//   - MouthOutput.closeLine(id, through): called on every output for a closing `brain.clause`
//   - MouthOutput.refuse(id, seq): called for a clause with seq > 0 on an output that is not ready or switched off live
//   - ClaimMemory.seen(id, seq?), .claim(id, sink, seq?) and .claimedBy(id, seq?) keyed per clause (seq defaults to 0)

const utterance = (id: string, seq: number, over: Record<string, unknown> = {}) =>
  event("voice.utterance", { id, seq, text: `t${seq}`, emotion: "neutral", durationMs: 100, envelopeHz: 50, envelope: [0], audioUrl: `http://voice/${id}-${seq}.wav`, sampleRate: 24000, ...over } as never);
const clauseEv = (data: Record<string, unknown>) => event("brain.clause" as never, data as never);

function spy(name: string, ready: () => boolean) {
  const calls: string[] = [];
  const o = {
    name, isReady: ready,
    playback: { enqueue: async (id: string, _url: string, utt?: { seq?: number; more?: true }) => { calls.push(`enqueue:${id}:${utt?.seq}:${utt?.more ?? ""}`); } },
    closeLine: (id: string, through: number) => { calls.push(`close:${id}:${through}`); },
    refuse: async (id: string, seq: number) => { calls.push(`refuse:${id}:${seq}`); },
    stop: async () => {},
  };
  return { o, calls };
}

// @spec MOUTH-PLAY-001
test("the one mouth loop also reads brain.clause", () => {
  assert.deepEqual([...MOUTH_LOOP_TYPES].sort(), ["brain.clause", "control", "voice.playing", "voice.stop", "voice.utterance"]);
});

// @spec MOUTH-PLAY-001, MOUTH-CLAUSE-005
test("a closing brain.clause is handed to every output with its through; a non-closing one is handed to none", async () => {
  const a = spy("discord", () => true);
  const b = spy("dryrun", () => false);
  const h = createMouthHandler({ outputs: [a.o, b.o] as never, log: recordingLog().log, bus: new FakeBus() });
  await h(clauseEv({ id: "x", seq: 2, text: "More.", }));
  assert.deepEqual([a.calls, b.calls], [[], []]);
  await h(clauseEv({ id: "x", seq: 3, text: "", last: true, through: 2 }));
  assert.deepEqual(a.calls, ["close:x:2"]);
  assert.deepEqual(b.calls, ["close:x:2"], "an output that is not ready is told too: it may hold the line");
});

// @spec MOUTH-PLAY-003, MOUTH-CLAUSE-002
test("an utterance's seq and more reach the output with it", async () => {
  const a = spy("discord", () => true);
  const h = createMouthHandler({ outputs: [a.o] as never, log: recordingLog().log, bus: new FakeBus() });
  await h(utterance("x", 0, { more: true }));
  await h(utterance("x", 1));
  assert.deepEqual(a.calls, ["enqueue:x:0:true", "enqueue:x:1:"]);
});

// @spec MOUTH-ROUTE-003, MOUTH-CLAUSE-008, MOUTH-CLAUSE-011
test("a later clause on an output that is not ready is refused there only; clause 0 is merely skipped, and ready outputs queue it", async () => {
  let ready = true;
  const a = spy("discord", () => ready);
  const b = spy("dryrun", () => true);
  const h = createMouthHandler({ outputs: [a.o, b.o] as never, log: recordingLog().log, bus: new FakeBus() });
  await h(utterance("x", 0, { more: true }));
  ready = false;
  await h(utterance("x", 1));
  assert.deepEqual(a.calls, ["enqueue:x:0:true", "refuse:x:1"]);
  assert.deepEqual(b.calls, ["enqueue:x:0:true", "enqueue:x:1:"], "the other output is unaffected");
  await h(utterance("y", 0)); // clause 0 on a not-ready output: skipped without a report
  assert.deepEqual(a.calls.slice(2), []);
});

// @spec MOUTH-LIVE-002, MOUTH-CLAUSE-008
test("an output switched off live refuses a later clause of a line open on it and queues nothing", async () => {
  let on = true;
  const a = spy("discord", () => true);
  const h = createMouthHandler({ outputs: [a.o] as never, enabled: () => on, log: recordingLog().log, bus: new FakeBus() });
  await h(utterance("x", 0, { more: true }));
  on = false;
  await h(utterance("x", 1));
  await h(utterance("z", 0));
  assert.deepEqual(a.calls, ["enqueue:x:0:true", "refuse:x:1"]);
});

// @spec MOUTH-ROUTE-008
test("a route that names no running output completes each clause with voice.playing then voice.done carrying its seq under sink mouth", async () => {
  const bus = new FakeBus();
  const a = spy("discord", () => true);
  const h = createMouthHandler({ outputs: [a.o] as never, log: recordingLog().log, bus });
  await h(utterance("x", 0, { route: [], more: true }));
  await h(utterance("x", 2, { route: [] }));
  assert.deepEqual(bus.published, [
    { type: "voice.playing", data: { id: "x", seq: 0, sink: "mouth" } },
    { type: "voice.done", data: { id: "x", seq: 0, sink: "mouth" } },
    { type: "voice.playing", data: { id: "x", seq: 2, sink: "mouth" } },
    { type: "voice.done", data: { id: "x", seq: 2, sink: "mouth" } },
  ]);
  assert.deepEqual(a.calls, []);
});

// @spec MOUTH-FALL-010
test("the loop forwards the seq of each utterance it saw and each voice.playing claim to the claim memory", async () => {
  const seen: unknown[][] = [];
  const claims: unknown[][] = [];
  const a = spy("discord", () => true);
  const h = createMouthHandler({
    outputs: [a.o] as never, log: recordingLog().log, bus: new FakeBus(),
    claims: { seen: (...args: unknown[]) => { seen.push(args); }, claim: (...args: unknown[]) => { claims.push(args); } } as never,
  });
  await h(utterance("x", 1));
  await h(event("voice.playing", { id: "x", seq: 1, sink: "dashboard" }));
  assert.deepEqual(seen, [["x", 1]]);
  assert.deepEqual(claims, [["x", "dashboard", 1]]);
});

// @spec MOUTH-FALL-009, MOUTH-FALL-010
test("claims are kept per clause: a claim on one clause does not suppress the fallback for another, and the memory holds the newest 50 lines", () => {
  const m = new ClaimMemory() as unknown as {
    seen(id: string, seq?: number): void; claim(id: string, sink: string, seq?: number): void; claimedBy(id: string, seq?: number): ReadonlySet<string>;
  };
  m.seen("a", 0);
  m.claim("a", "dashboard", 1);
  m.claim("a", "virtual", 0);
  assert.deepEqual([...m.claimedBy("a", 1)], ["dashboard"]);
  assert.deepEqual([...m.claimedBy("a", 0)], [], "virtual is not a real sink");
  for (let i = 0; i < 49; i++) m.claim(`l${i}`, "dashboard", 0);
  for (let s = 0; s < 80; s++) m.claim("a", "dashboard", s); // many clauses of one line are still one line
  assert.deepEqual([...m.claimedBy("a", 79)], ["dashboard"], "line a is among the newest 50");
  m.claim("newest", "dashboard", 0);
  assert.deepEqual([...m.claimedBy("a", 79)], [], "the 51st line pushed the oldest line (a, every clause of it) out");
  assert.deepEqual([...m.claimedBy("l0", 0)], ["dashboard"]);

  const cache = new ClipCache();
  const wav = Buffer.from("x");
  cache.replace({ fingerprint: "fp", clips: [{ name: "c", text: "t", durationMs: 1, bytes: 1, sha256: "x", wav }] });
  const memory = new ClaimMemory() as unknown as ClaimMemory & { claim(id: string, sink: string, seq?: number): void };
  const line = new FallbackLine({ cache, claims: memory, sink: "discord", minIntervalMs: 0, random: () => 0 }) as unknown as { pick(id: string, seq: number): unknown };
  memory.claim("b", "dashboard", 1);
  assert.equal(line.pick("b", 1), undefined, "claimed clause: no fallback (MOUTH-FALL-009)");
  assert.ok(line.pick("b", 2), "an unclaimed clause of the same line still gets a fallback");
  assert.ok(line.pick("b", 0));
});
