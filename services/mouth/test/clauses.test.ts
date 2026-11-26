import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeBus, recordingLog, waitFor } from "@cohost/testing";
import { wavWrap } from "@cohost/shared";
import { ClipCache, type FallbackClip } from "../src/clips.js";
import { ClaimMemory, FallbackLine } from "../src/fallback.js";
import { Playback } from "../src/playback.js";

// Clauses of a line on one output's queue (MOUTH-CLAUSE-*, MOUTH-PLAY-*).
//
// Seams the code phase provides (named here, adjustable by the code phase):
//   - playback.enqueue(id, url, utt?: { text, durationMs, seq?: number, more?: true }): `seq` defaults to 0; `more` is set on clause 0 of a streamed line
//   - playback.closeLine(id, through): the closing `brain.clause` (MOUTH-CLAUSE-005, 006)
//   - playback.refuse(id, seq): the output cannot take a later clause of the line (not ready, switched off live; MOUTH-CLAUSE-008)
//   - PlaybackDeps.lineIdleMs: the 300 s no-activity bound as a test knob (default 300_000)

const clip = (text: string): FallbackClip => {
  const body = wavWrap(Buffer.alloc(2400 * 2, 7), 24000, 1);
  return { name: `00-${text.length}.wav`, text, durationMs: 100, bytes: body.length, sha256: "x", wav: body };
};
const C = (text: string, seq: number, more?: true) => ({ text, durationMs: 100, seq, ...(more ? { more } : {}) });
const url = (id: string, seq: number) => `http://voice/${id}-${seq}.wav`;
type LineApi = {
  enqueue(id: string, url: string, utt?: unknown): Promise<void>;
  closeLine(id: string, through: number): void;
  refuse(id: string, seq: number): Promise<void>;
};
const line = (p: Playback) => p as unknown as LineApi;
const events = (bus: FakeBus) => bus.published.map((e) => `${e.type}:${(e.data as { seq: number }).seq}${(e.data as { final?: boolean }).final ? ":final" : ""}`);

function rig(fail: (url: string) => boolean = () => false, extra: Record<string, unknown> = {}) {
  const bus = new FakeBus();
  const fetched: string[] = [];
  const p = new Playback({
    bus, log: recordingLog().log, sink: "discord", gainDb: 0,
    fetchAudio: async (u: string) => { fetched.push(u); if (fail(u)) throw new Error("fetch audio 404"); return wavWrap(Buffer.alloc(4800), 24000, 1); },
    play: () => {},
    ...extra,
  } as never);
  return { p, bus, fetched };
}

// @spec MOUTH-PLAY-003, MOUTH-PLAY-004, MOUTH-CLAUSE-001, MOUTH-CLAUSE-002, MOUTH-CLAUSE-003
test("each clause of a line plays through the one queue, one at a time, reported with its own seq, idling between clauses", async () => {
  const { p, bus, fetched } = rig();
  await line(p).enqueue("a", url("a", 0), C("One.", 0, true));
  await line(p).enqueue("a", url("a", 1), C("Two.", 1));
  assert.deepEqual(fetched, [url("a", 0)], "clause 1 waits for clause 0");
  assert.deepEqual(events(bus), ["voice.playing:0"]);
  await p.onIdle();
  assert.deepEqual(events(bus), ["voice.playing:0", "voice.done:0", "voice.playing:1"]);
  await p.onIdle(); // between clauses: nothing current
  await line(p).enqueue("a", url("a", 2), C("Three.", 2));
  assert.deepEqual(events(bus).slice(3), ["voice.done:1", "voice.playing:2"], "a clause arriving while the output idles plays at once");
  assert.ok(bus.published.every((e) => (e.data as { id: string }).id === "a" && (e.data as { sink: string }).sink === "discord"));
});

// @spec MOUTH-CLAUSE-004
test("an output that never took clause 0 skips every later clause of the line: no fetch, no event", async () => {
  const { p, bus, fetched } = rig();
  await line(p).enqueue("a", url("a", 1), C("Two.", 1));
  await line(p).enqueue("a", url("a", 2), C("Three.", 2));
  assert.deepEqual(fetched, []);
  assert.deepEqual(bus.published, []);
});

// @spec MOUTH-CLAUSE-005, MOUTH-CLAUSE-006, MOUTH-CLAUSE-007
test("the closing event drops queued clauses above through without events and the line ends when through has finished", async () => {
  const { p, bus, fetched } = rig();
  await line(p).enqueue("a", url("a", 0), C("One.", 0, true));
  await line(p).enqueue("a", url("a", 1), C("Two.", 1));
  await line(p).enqueue("a", url("a", 2), C("Three.", 2));
  line(p).closeLine("a", 1);
  await p.onIdle();
  await p.onIdle();
  assert.deepEqual(events(bus), ["voice.playing:0", "voice.done:0", "voice.playing:1", "voice.done:1"]);
  await line(p).enqueue("a", url("a", 3), C("Four.", 3)); // the line has ended: skipped as it arrives
  assert.deepEqual(fetched, [url("a", 0), url("a", 1)], "clauses 2 and 3 were never fetched");
  assert.equal(bus.published.length, 4);
});

// @spec MOUTH-CLAUSE-005
test("a closing event whose through has already finished ends the line at once", async () => {
  const { p, bus, fetched } = rig();
  await line(p).enqueue("a", url("a", 0), C("One.", 0, true));
  await p.onIdle();
  line(p).closeLine("a", 0);
  await line(p).enqueue("a", url("a", 1), C("Two.", 1));
  assert.deepEqual(fetched, [url("a", 0)]);
  assert.deepEqual(events(bus), ["voice.playing:0", "voice.done:0"]);
});

// @spec MOUTH-CLAUSE-005
test("a line closed at a through voice never published stays open until the no-activity bound", async () => {
  const { p, fetched } = rig(() => false, { lineIdleMs: 60 });
  await line(p).enqueue("a", url("a", 0), C("One.", 0, true));
  await p.onIdle();
  await line(p).enqueue("a", url("a", 1), C("Two.", 1));
  await p.onIdle();
  line(p).closeLine("a", 2); // clause 2 was never published to the output
  await line(p).enqueue("a", url("a", 2), C("Three.", 2));
  assert.equal(fetched.at(-1), url("a", 2), "still open: a late clause at or below through plays");
  await p.onIdle();
  await new Promise((r) => setTimeout(r, 120));
  await line(p).enqueue("a", url("a", 3), C("Four.", 3));
  assert.equal(fetched.includes(url("a", 3)), false, "after 60 ms without clause activity the line has ended and later clauses are skipped");
});

// @spec MOUTH-CLAUSE-008
test("a later clause the output cannot take is a final done with its seq and no playing, and ends the line on this output", async () => {
  const { p, bus, fetched } = rig();
  await line(p).enqueue("a", url("a", 0), C("One.", 0, true));
  await p.onIdle();
  await line(p).refuse("a", 1);
  assert.deepEqual(events(bus), ["voice.playing:0", "voice.done:0", "voice.done:1:final"]);
  assert.deepEqual(bus.of("voice.done").at(-1), { id: "a", seq: 1, sink: "discord", final: true });
  await line(p).enqueue("a", url("a", 2), C("Three.", 2));
  assert.deepEqual(fetched, [url("a", 0)], "later clauses are skipped");
  assert.equal(bus.published.length, 3, "nothing is reported after the first final done");
});

// @spec MOUTH-CLAUSE-004, MOUTH-CLAUSE-008
test("a clause the output cannot take of a line never opened on it publishes nothing", async () => {
  const { p, bus } = rig();
  await line(p).refuse("never-opened", 1);
  assert.deepEqual(bus.published, []);
});

// @spec MOUTH-CLAUSE-009, MOUTH-PLAY-005, MOUTH-PLAY-006
test("a give-up on a later clause with no fallback is voice.failed with its seq then a final done, and the line's other clauses are dropped", async () => {
  const { p, bus, fetched } = rig((u) => u.includes("a-1"));
  await line(p).enqueue("a", url("a", 0), C("One.", 0, true));
  await line(p).enqueue("a", url("a", 1), C("Two.", 1));
  await line(p).enqueue("a", url("a", 2), C("Three.", 2));
  await p.onIdle();
  await waitFor(() => bus.of("voice.failed").length === 1);
  assert.deepEqual(events(bus), ["voice.playing:0", "voice.done:0", "voice.failed:1", "voice.done:1:final"]);
  assert.deepEqual(bus.of("voice.failed"), [{ id: "a", seq: 1, sink: "discord", reason: "Error: fetch audio 404" }]);
  assert.equal(fetched.includes(url("a", 2)), false, "the line ended with the give-up: clause 2 is dropped without events");
});

// @spec MOUTH-CLAUSE-009
test("a give-up on clause 0, a line never open on the output, is a plain voice.failed with no final done", async () => {
  const { p, bus } = rig((u) => u.includes("a-0"));
  await line(p).enqueue("a", url("a", 0), C("One.", 0, true));
  assert.deepEqual(events(bus), ["voice.failed:0"]);
});

// @spec MOUTH-CLAUSE-010, MOUTH-FALL-002, MOUTH-FALL-003
test("a give-up with a fallback clip claims the clause's id and seq, fails it, ends with a final done when the clip ends, and ends the line", async () => {
  const cache = new ClipCache();
  cache.replace({ fingerprint: "fp", clips: [clip("Error: unable to play line.")] });
  const fallback = new FallbackLine({ cache, claims: new ClaimMemory(), sink: "discord", minIntervalMs: 0, random: () => 0 });
  const { p, bus, fetched } = rig((u) => u.includes("a-1"), { fallback });
  await line(p).enqueue("a", url("a", 0), C("One.", 0, true));
  await line(p).enqueue("a", url("a", 1), C("Two.", 1));
  await line(p).enqueue("a", url("a", 2), C("Three.", 2));
  await p.onIdle();
  await waitFor(() => bus.of("voice.failed").length === 1);
  assert.deepEqual(events(bus), ["voice.playing:0", "voice.done:0", "voice.playing:1", "voice.failed:1"]);
  assert.deepEqual(bus.of("voice.failed")[0]!.fallback, { clip: "00-27.wav", text: "Error: unable to play line." });
  await p.onIdle(); // the clip ends
  assert.deepEqual(bus.of("voice.done").at(-1), { id: "a", seq: 1, sink: "discord", final: true });
  assert.equal(fetched.includes(url("a", 2)), false, "the clip ended the line: clause 2 never plays");
});

// @spec MOUTH-CLAUSE-011
test("a final done on one output changes nothing on another output's queue or line", async () => {
  const a = rig();
  const b = rig();
  await line(a.p).enqueue("x", url("x", 0), C("One.", 0, true));
  await line(b.p).enqueue("x", url("x", 0), C("One.", 0, true));
  await line(a.p).refuse("x", 1);
  await b.p.onIdle();
  await line(b.p).enqueue("x", url("x", 1), C("Two.", 1));
  assert.deepEqual(events(b.bus), ["voice.playing:0", "voice.done:0", "voice.playing:1"], "output b still plays the line");
});

// @spec MOUTH-PLAY-012
test("a full queue drops the oldest queued line that is not open, whole, with the warning and no event or fallback", async () => {
  const rec = recordingLog();
  const bus = new FakeBus();
  const fetched: string[] = [];
  const cache = new ClipCache();
  cache.replace({ fingerprint: "fp", clips: [clip("x")] });
  const fallback = new FallbackLine({ cache, claims: new ClaimMemory(), sink: "discord", minIntervalMs: 0, random: () => 0 });
  const p = new Playback({
    bus, log: rec.log, sink: "discord", gainDb: 0, maxQueue: 2, fallback,
    fetchAudio: async (u: string) => { fetched.push(u); return wavWrap(Buffer.alloc(4800), 24000, 1); },
    play: () => {},
  });
  await line(p).enqueue("x", url("x", 0), C("Current.", 0)); // current, never idles on its own
  void line(p).enqueue("a", url("a", 0), C("A one.", 0, true));
  void line(p).enqueue("a", url("a", 1), C("A two.", 1));
  void line(p).enqueue("b", url("b", 0), C("B one.", 0)); // the 21st: line a is dropped whole
  assert.deepEqual(rec.msgs("warn"), ["queue full: dropped oldest queued utterance"]);
  await p.onIdle();
  assert.deepEqual(fetched, [url("x", 0), url("b", 0)], "a's clauses are never fetched; b plays after x");
  assert.deepEqual(bus.of("voice.failed"), []);
  assert.deepEqual(bus.of("voice.playing").map((e) => e.id), ["x", "b"]);
});

// @spec MOUTH-PLAY-012, MOUTH-CLAUSE-012
test("when every queued line is open on the output, the oldest queued clause is dropped and its line ends on the output", async () => {
  const { p, bus, fetched } = rig(() => false, { maxQueue: 2 });
  await line(p).enqueue("x", url("x", 0), C("One.", 0, true)); // current: line x is open
  void line(p).enqueue("x", url("x", 1), C("Two.", 1));
  void line(p).enqueue("x", url("x", 2), C("Three.", 2));
  void line(p).enqueue("x", url("x", 3), C("Four.", 3)); // over the limit, every queued line is open
  await p.onIdle();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(fetched, [url("x", 0)], "the line ended on the output: none of its later clauses plays");
  assert.deepEqual(bus.of("voice.failed"), []);
  assert.deepEqual(bus.of("voice.playing").map((e) => e.seq), [0]);
});

// @spec MOUTH-CLAUSE-005
test("a closing brain.clause that arrives before clause 0 applies to the line when clause 0 arrives", async () => {
  const { p, bus, fetched } = rig();
  line(p).closeLine("a", 0);
  await line(p).enqueue("a", url("a", 0), C("One.", 0, true));
  await p.onIdle();
  await line(p).enqueue("a", url("a", 1), C("Two.", 1));
  assert.deepEqual(fetched, [url("a", 0)], "clause 1 is above through: skipped");
  assert.deepEqual(events(bus), ["voice.playing:0", "voice.done:0"]);
});

// @spec MOUTH-CLAUSE-005
test("a line idle past the bound ends silently on refuse and on stop: no final done and no interrupted done", async () => {
  const { p, bus } = rig(() => false, { lineIdleMs: 60 });
  await line(p).enqueue("a", url("a", 0), C("One.", 0, true));
  await p.onIdle();
  await new Promise((r) => setTimeout(r, 120));
  await line(p).refuse("a", 1);
  await p.stop({ ids: ["a"] });
  assert.deepEqual(events(bus), ["voice.playing:0", "voice.done:0"]);
});

// @spec MOUTH-PLAY-012, MOUTH-CLAUSE-012
test("a full queue whose every queued line is open publishes a final done for the clause it drops", async () => {
  const { p, bus } = rig(() => false, { maxQueue: 2 });
  await line(p).enqueue("x", url("x", 0), C("One.", 0, true));
  void line(p).enqueue("x", url("x", 1), C("Two.", 1));
  void line(p).enqueue("x", url("x", 2), C("Three.", 2));
  void line(p).enqueue("x", url("x", 3), C("Four.", 3));
  await p.onIdle();
  assert.deepEqual(bus.of("voice.done").filter((d) => (d as { final?: boolean }).final), [{ id: "x", seq: 1, sink: "discord", final: true }]);
});
