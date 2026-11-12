import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeBus, recordingLog, waitFor } from "@cohost/testing";
import { wavWrap } from "@cohost/shared";
import { wavToDiscordPcm } from "../src/audio.js";
import { ClipCache, type FallbackClip } from "../src/clips.js";
import { ClaimMemory, FallbackLine } from "../src/fallback.js";
import { FETCH_TIMEOUT_MS, MAX_QUEUE, Playback, STUCK_GRACE_MS } from "../src/playback.js";

const clip = (text: string): FallbackClip => {
  const body = wavWrap(Buffer.alloc(2400 * 2, 7), 24000, 1);
  return { name: `00-${text.length}.wav`, text, durationMs: 100, bytes: body.length, sha256: "x", wav: body };
};

/** A 100 ms line; the player never reports Idle on its own. `stop` mimics discord.js, which emits Idle synchronously. */
function guarded(over: Partial<ConstructorParameters<typeof Playback>[0]> = {}, clips: FallbackClip[] = []) {
  const bus = new FakeBus();
  const rec = recordingLog();
  const played: Buffer[] = [];
  const fetched: string[] = [];
  const stops: number[] = [];
  const cache = new ClipCache();
  cache.replace({ fingerprint: "fp", clips });
  const fallback = new FallbackLine({ cache, claims: new ClaimMemory(), sink: "discord", minIntervalMs: 0, random: () => 0 });
  const box: { p?: Playback } = {};
  const p = new Playback({
    bus, log: rec.log, sink: "discord", gainDb: 0, fallback, fetchTimeoutMs: 40, watchdogGraceMs: 40,
    fetchAudio: async (url) => { fetched.push(url); return wavWrap(Buffer.alloc(4800), 24000, 1); },
    play: (pcm) => { played.push(pcm); },
    stop: () => { stops.push(played.length); void box.p!.onIdle(); },
    ...over,
  });
  box.p = p;
  return { p, bus, rec, played, fetched, stops };
}

// @spec MOUTH-PLAY-010, MOUTH-PLAY-011, MOUTH-PLAY-012
test("guard: the limits are 15 s, 10 s and 20 lines", () => {
  assert.deepEqual([FETCH_TIMEOUT_MS, STUCK_GRACE_MS, MAX_QUEUE], [15_000, 10_000, 20]);
});

// @spec MOUTH-PLAY-010
test("guard: a fetch that never answers is abandoned after the timeout and given up, then the next line plays", async () => {
  const { p, bus, rec, played } = guarded({
    fetchAudio: (url) => (url.includes("hang") ? new Promise<Buffer>(() => {}) : Promise.resolve(wavWrap(Buffer.alloc(4800), 24000, 1))),
  });
  try {
    const t0 = performance.now();
    await Promise.all([p.enqueue("hang", "http://voice/hang.wav"), p.enqueue("ok", "http://voice/ok.wav")]);
    await waitFor(() => bus.of("voice.playing").length === 1, "the next line playing");
    assert.ok(performance.now() - t0 >= 35, "waited for the timeout");
    const [failed] = bus.of("voice.failed");
    assert.equal(failed!.id, "hang");
    assert.match(failed!.reason, /timed out/);
    assert.deepEqual(rec.msgs("warn"), ["playback failed"]);
    assert.equal(played.length, 1);
  } finally {
    p.close();
  }
});

// @spec MOUTH-PLAY-011
test("guard: a player that never goes idle is stopped, the utterance given up, and the next line plays; the stop's idle ends nothing", async () => {
  const { p, bus, rec, played, stops } = guarded();
  try {
    await Promise.all([p.enqueue("a", "http://voice/a.wav"), p.enqueue("b", "http://voice/b.wav")]);
    assert.deepEqual(bus.types(), ["voice.playing"], "a is playing and stays current");
    await waitFor(() => bus.of("voice.playing").length === 2, "b playing after the watchdog");
    assert.deepEqual(stops, [1], "the player was stopped once, with only a handed over");
    const [failed] = bus.of("voice.failed");
    assert.equal(failed!.id, "a");
    assert.ok(failed!.reason.startsWith("playback stuck"), failed!.reason);
    assert.equal(bus.of("voice.done").length, 0, "the stop's idle published no voice.done");
    assert.equal(played.length, 2, "b played exactly once");
    assert.deepEqual(rec.msgs("warn"), ["playback stuck"]);
    const line = rec.lines.find((l) => l.msg === "playback stuck")!.obj as { id: string; output: string };
    assert.deepEqual([line.id, line.output], ["a", "discord"]);
  } finally {
    p.close();
  }
});

// @spec MOUTH-PLAY-011
test("guard: a stuck utterance is replaced by a fallback clip, and a clip that sticks ends with voice.done", async () => {
  const c = clip("Error: unable to play line.");
  const { p, bus, played } = guarded({}, [c]);
  try {
    await Promise.all([p.enqueue("a", "http://voice/a.wav"), p.enqueue("b", "http://voice/b.wav")]);
    await waitFor(() => bus.of("voice.failed").length === 1, "a given up");
    assert.deepEqual(bus.of("voice.failed")[0]!.fallback, { clip: c.name, text: c.text });
    assert.deepEqual(played[1], wavToDiscordPcm(c.wav), "the clip is playing in a's place");
    assert.equal(bus.of("voice.done").length, 0, "the stop's idle did not end the clip");
    await waitFor(() => bus.of("voice.done").length === 1, "the stuck clip released");
    assert.deepEqual(bus.of("voice.done"), [{ id: "a", sink: "discord" }]);
    await waitFor(() => bus.of("voice.playing").some((e) => e.id === "b"), "b playing");
  } finally {
    p.close();
  }
});

// @spec MOUTH-PLAY-011
test("guard: a line that finishes in time disarms the watchdog", async () => {
  const { p, bus, stops } = guarded({ watchdogGraceMs: 30 });
  try {
    await p.enqueue("a", "http://voice/a.wav");
    await p.onIdle();
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(stops, []);
    assert.equal(bus.of("voice.failed").length, 0);
    assert.deepEqual(bus.of("voice.done"), [{ id: "a", sink: "discord" }]);
  } finally {
    p.close();
  }
});

// @spec MOUTH-PLAY-012
test("guard: past the queue limit the oldest line is dropped with a warning and no event", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const fetched: string[] = [];
  const { p, bus, rec } = guarded({
    maxQueue: 2, fetchTimeoutMs: 60_000,
    fetchAudio: async (url) => { fetched.push(url); if (url.includes("first")) await gate; return wavWrap(Buffer.alloc(4800), 24000, 1); },
  });
  try {
    void p.enqueue("first", "http://voice/first.wav");
    void p.enqueue("q1", "http://voice/q1.wav");
    void p.enqueue("q2", "http://voice/q2.wav");
    void p.enqueue("q3", "http://voice/q3.wav");
    assert.deepEqual(rec.msgs("warn"), ["queue full: dropped oldest queued utterance"]);
    assert.equal((rec.lines[0]!.obj as { id: string }).id, "q1");
    release();
    await waitFor(() => bus.of("voice.playing").length === 1, "first playing");
    await p.onIdle();
    await p.onIdle();
    await waitFor(() => fetched.length === 3, "the survivors fetched");
    assert.deepEqual(fetched, ["http://voice/first.wav", "http://voice/q2.wav", "http://voice/q3.wav"]);
    assert.equal(bus.of("voice.failed").length, 0, "a drop is a skip, not a give-up");
    assert.ok(!bus.of("voice.playing").some((e) => e.id === "q1"));
  } finally {
    p.close();
  }
});
