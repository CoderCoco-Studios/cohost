import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeBus, recordingLog, waitFor } from "@cohost/testing";
import { wavWrap } from "@cohost/shared";
import { ClipCache, type FallbackClip } from "../src/clips.js";
import { ClaimMemory, FallbackLine } from "../src/fallback.js";
import { createDryrunOutput } from "../src/dryrun.js";

const wav = (ms: number) => wavWrap(Buffer.alloc((24 * ms) * 2), 24000, 1);
const clip = (ms: number): FallbackClip => {
  const body = wav(ms);
  return { name: "00-clip.wav", text: "Error: unable to play line.", durationMs: ms, bytes: body.length, sha256: "x", wav: body };
};

function rig(opts: { failEvery?: number; lineMs?: number; clipMs?: number } = {}) {
  const bus = new FakeBus();
  const rec = recordingLog();
  const cache = new ClipCache();
  cache.replace({ fingerprint: "fp", clips: [clip(opts.clipMs ?? 60)] });
  const fallback = new FallbackLine({ cache, claims: new ClaimMemory(), sink: "dryrun", minIntervalMs: 0, random: () => 0 });
  const fetched: string[] = [];
  const out = createDryrunOutput({
    bus, log: rec.log, failEvery: opts.failEvery ?? 0, fallback,
    fetchAudio: async (url) => { fetched.push(url); return wav(opts.lineMs ?? 80); },
  });
  return { out, bus, rec, fetched };
}

// @spec MOUTH-DRY-001
test("dryrun: the output is named dryrun and is ready from startup", () => {
  const { out } = rig();
  try {
    assert.equal(out.name, "dryrun");
    assert.equal(out.isReady(), true);
  } finally {
    out.close();
  }
});

// @spec MOUTH-DRY-002
test("dryrun: fetches the WAV, claims it under sink dryrun, waits its duration and then reports done", async () => {
  const { out, bus, fetched } = rig({ lineMs: 80 });
  try {
    const t0 = performance.now();
    await out.playback.enqueue("a", "http://voice/a.wav");
    assert.deepEqual(fetched, ["http://voice/a.wav"]);
    assert.deepEqual(bus.published, [{ type: "voice.playing", data: { id: "a", sink: "dryrun" } }]);
    await waitFor(() => bus.of("voice.done").length === 1, "voice.done");
    assert.ok(performance.now() - t0 >= 75, "waited the WAV's duration");
    assert.deepEqual(bus.of("voice.done"), [{ id: "a", sink: "dryrun" }]);
  } finally {
    out.close();
  }
});

// @spec MOUTH-DRY-002
test("dryrun: a line that is not a 16-bit WAV is given up like on any output", async () => {
  const bus = new FakeBus();
  const out = createDryrunOutput({ bus, log: recordingLog().log, failEvery: 0, fetchAudio: async () => Buffer.from("not a wav") });
  try {
    await out.playback.enqueue("a", "http://voice/a.wav");
    assert.equal(bus.of("voice.failed").length, 1);
    assert.equal(bus.of("voice.failed")[0]!.sink, "dryrun");
  } finally {
    out.close();
  }
});

// @spec MOUTH-DRY-003
test("dryrun: fail_every n gives up on every n-th utterance, runs the fallback line timed like a line, and never counts clips", async () => {
  const { out, bus } = rig({ failEvery: 2, lineMs: 30, clipMs: 40 });
  try {
    for (const id of ["u1", "u2", "u3", "u4"]) {
      await out.playback.enqueue(id, `http://voice/${id}.wav`);
      await waitFor(() => bus.of("voice.done").some((d) => d.id === id), `done ${id}`);
    }
    assert.deepEqual(bus.of("voice.failed").map((f) => f.id), ["u2", "u4"]);
    const f = bus.of("voice.failed")[0]!;
    assert.equal(f.sink, "dryrun");
    assert.deepEqual(f.fallback, { clip: "00-clip.wav", text: "Error: unable to play line." });
    assert.deepEqual(bus.of("voice.playing").map((p) => p.id), ["u1", "u2", "u3", "u4"], "a clip claims the given-up id");
    assert.deepEqual(bus.of("voice.done").map((d) => d.id), ["u1", "u2", "u3", "u4"], "each ends once, the clip's end releasing u2");
  } finally {
    out.close();
  }
});

// @spec MOUTH-DRY-003
test("dryrun: fail_every 0 never gives up", async () => {
  const { out, bus } = rig({ failEvery: 0, lineMs: 10 });
  try {
    for (const id of ["a", "b", "c"]) {
      await out.playback.enqueue(id, `http://voice/${id}.wav`);
      await waitFor(() => bus.of("voice.done").some((d) => d.id === id), `done ${id}`);
    }
    assert.equal(bus.of("voice.failed").length, 0);
  } finally {
    out.close();
  }
});
