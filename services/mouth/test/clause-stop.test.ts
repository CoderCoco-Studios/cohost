import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeBus, recordingLog } from "@cohost/testing";
import { wavWrap } from "@cohost/shared";
import { ClipCache, type FallbackClip } from "../src/clips.js";
import { ClaimMemory, FallbackLine } from "../src/fallback.js";
import { createDryrunOutput } from "../src/dryrun.js";
import { createFileOutput } from "../src/file-output.js";

// voice.stop on streamed lines (MOUTH-STOP-003, 005, 007, 008, MOUTH-CLAUSE-013..017).
// Seams as in clauses.test.ts: playback.enqueue(id, url, { text, durationMs, seq?, more? }).

const wav = (ms: number) => wavWrap(Buffer.alloc(24 * ms * 2), 24000, 1);
const clip = (ms: number): FallbackClip => { const body = wav(ms); return { name: "00-clip.wav", text: "Error: unable to play line.", durationMs: ms, bytes: body.length, sha256: "x", wav: body }; };
const U = (text: string, durationMs: number, seq: number, more?: true) => ({ text, durationMs, seq, ...(more ? { more } : {}) });
type Out = { playback: { enqueue(...a: never[]): Promise<void> }; stop(order: { ids?: string[] }): Promise<void> };
const put = (o: Out, id: string, seq: number, utt: unknown) => (o.playback.enqueue as unknown as (id: string, url: string, utt: unknown) => Promise<void>)(id, `http://voice/${id}-${seq}.wav`, utt);
const settle = () => new Promise((r) => setTimeout(r, 30));
const deferred = () => { let release!: () => void; const gate = new Promise<void>((r) => { release = r; }); return { gate, release }; };

/** A dryrun output whose clause `<id>-<seq>` lasts `ms[<key>]` (default 5000) and whose clock the test moves. */
function dry(ms: Record<string, number> = {}, opts: { clips?: FallbackClip[]; gate?: (url: string) => Promise<void> } = {}) {
  const bus = new FakeBus();
  const clock = { t: 0 };
  const cache = new ClipCache();
  cache.replace({ fingerprint: "fp", clips: opts.clips ?? [] });
  const fallback = new FallbackLine({ cache, claims: new ClaimMemory(), sink: "dryrun", minIntervalMs: 0, random: () => 0 });
  const out = createDryrunOutput({
    bus, log: recordingLog().log, failEvery: 0, fallback, now: () => clock.t,
    fetchAudio: async (u) => { await opts.gate?.(u); const key = /\/([^/]+)\.wav$/.exec(u)![1]!; return wav(ms[key] ?? 5000); },
  } as never);
  return { out, bus, clock };
}

// @spec MOUTH-STOP-003, MOUTH-STOP-005, MOUTH-CLAUSE-016
test("stopping the current clause of a line publishes one interrupted done with that clause's seq and the split over the whole line", async () => {
  const { out, bus, clock } = dry({ "a-0": 10 });
  try {
    await put(out, "a", 0, U("One two.", 10, 0, true));
    await new Promise((r) => setTimeout(r, 40)); // clause 0 finishes
    await put(out, "a", 1, U("aaaa bbbb cccc dddd", 5000, 1));
    void put(out, "a", 2, U("seven eight", 5000, 2));
    clock.t = 2500; // half of clause 1
    await out.stop({ ids: ["a"] });
    await settle();
    const done = bus.of("voice.done");
    assert.deepEqual(done.map((d) => d.seq), [0, 1], "clause 0's own done, then exactly one interrupted done for clause 1");
    assert.deepEqual(done[1], { id: "a", seq: 1, sink: "dryrun", interrupted: true, spokenText: "One two. aaaa bbbb", unsaidText: "cccc dddd seven eight" });
    assert.deepEqual(bus.of("voice.failed"), []);
    assert.deepEqual(bus.of("voice.playing").map((p) => p.seq), [0, 1], "the queued clause 2 never played");
  } finally { out.close(); }
});

// @spec MOUTH-CLAUSE-014, MOUTH-CLAUSE-016
test("a stop between two clauses of an open line publishes one interrupted done with the last played seq and the played text", async () => {
  const { out, bus } = dry({ "a-0": 10, "a-1": 10 });
  try {
    await put(out, "a", 0, U("One two.", 10, 0, true));
    await new Promise((r) => setTimeout(r, 40));
    await put(out, "a", 1, U("Three four.", 10, 1));
    await new Promise((r) => setTimeout(r, 40)); // both finished, line still open, nothing current
    await out.stop({ ids: ["a"] });
    const done = bus.of("voice.done");
    assert.equal(done.length, 3);
    assert.deepEqual(done[2], { id: "a", seq: 1, sink: "dryrun", interrupted: true, spokenText: "One two. Three four.", unsaidText: "" });
  } finally { out.close(); }
});

// @spec MOUTH-CLAUSE-013, MOUTH-STOP-007
test("a stop ends the line: its queued clauses and a clause read after the stop are dropped without events, and a later line plays", async () => {
  const { out, bus } = dry({ "a-0": 5000, "b-0": 20 });
  try {
    await put(out, "a", 0, U("One.", 5000, 0, true));
    void put(out, "a", 1, U("Two.", 5000, 1));
    await out.stop({ ids: ["a"] });
    await put(out, "a", 2, U("Three.", 5000, 2)); // published before the stop, read after it
    await put(out, "b", 0, U("Other.", 20, 0));
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(bus.of("voice.playing").map((p) => `${p.id}:${p.seq}`), ["a:0", "b:0"]);
    assert.equal(bus.of("voice.done").filter((d) => d.id === "a").length, 1, "one interrupted done, none for the dropped clauses");
    assert.deepEqual(bus.of("voice.failed"), []);
  } finally { out.close(); }
});

// @spec MOUTH-CLAUSE-014, MOUTH-CLAUSE-015, MOUTH-STOP-008
test("a stop reports an open line whose next clause is still being fetched as between clauses, and publishes nothing for a line that ended or was never opened", async () => {
  const slow = deferred();
  const { out, bus } = dry({ "a-0": 10, "c-0": 10 }, { gate: (u) => (u.includes("a-1") ? slow.gate : Promise.resolve()) });
  try {
    await put(out, "a", 0, U("One.", 10, 0, true));
    await new Promise((r) => setTimeout(r, 40));
    void put(out, "a", 1, U("Two.", 10, 1)); // clause 1 of an open line is being fetched
    await settle();
    await out.stop({ ids: ["a"] });
    slow.release();
    await settle();
    // Clause 0 played and the line is open: the fetching clause is abandoned and is unsaid text of the last played clause.
    assert.deepEqual(bus.of("voice.done").filter((d) => (d as { interrupted?: boolean }).interrupted), [
      { id: "a", seq: 0, sink: "dryrun", interrupted: true, spokenText: "One.", unsaidText: "Two." },
    ]);
    const before = bus.published.length;
    await out.stop({ ids: ["a", "never-routed"] }); // a is ended now, the other id was never here
    await out.stop({});
    assert.equal(bus.published.length, before, "nothing changes and nothing is published");
    await put(out, "c", 0, U("Whole.", 10, 0)); // not streamed: finishes
    await new Promise((r) => setTimeout(r, 40));
    const n = bus.published.length;
    await out.stop({ ids: ["c"] });
    assert.equal(bus.published.length, n, "a line that finished gets nothing");
  } finally { slow.release(); out.close(); }
});

// @spec MOUTH-STOP-005, MOUTH-CLAUSE-017
test("file output and an interrupted fallback clip set neither spokenText nor unsaidText on a later clause's interrupted done", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mouth-clause-stop-"));
  const bus = new FakeBus();
  const file = createFileOutput({ bus, log: recordingLog().log, dir, maxFiles: 5, fetchAudio: async (u) => wav(u.includes("-0") ? 10 : 2000) });
  try {
    await put(file, "f", 0, U("One.", 10, 0, true));
    await new Promise((r) => setTimeout(r, 40));
    await put(file, "f", 1, U("Two.", 2000, 1));
    await file.stop({ ids: ["f"] });
    const d = bus.of("voice.done").at(-1) as Record<string, unknown>;
    assert.equal(d.seq, 1);
    assert.equal(d.interrupted, true);
    assert.ok(!("spokenText" in d) && !("unsaidText" in d));
  } finally { file.close(); rmSync(dir, { recursive: true, force: true }); }
});
