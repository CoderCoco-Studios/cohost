import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile, appendFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { silentLog, waitFor } from "@cohost/testing";
import { INJECT_QUEUE_LIMIT, wavWrap } from "@cohost/shared";
import { createDirCapture } from "../src/capture-dir.js";
import type { Clip, HearClip, HearOutcome } from "../src/capture.js";

const wav = (ms = 500) => wavWrap(Buffer.alloc((ms / 1000) * 32000), 16000, 1);

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "ears-dir-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function rig(dir: string, outcome: HearOutcome | (() => HearOutcome) = { heard: true, text: "ok" }, over: Record<string, unknown> = {}) {
  const calls: { clip: Clip; speaker: string; source?: string }[] = [];
  const hear: HearClip = async (clip, speaker, source) => { calls.push({ clip, speaker, source }); return typeof outcome === "function" ? outcome() : outcome; };
  const cap = createDirCapture({ path: dir, pollMs: 10, log: silentLog, hear, ...over });
  return { cap, calls };
}
const names = async (dir: string) => (await readdir(dir)).sort();

// @spec EARS-CAP-008, EARS-CAP-009
test("a dropped WAV is processed once, after two polls see the same size, and renamed .done", async () => {
  await withDir(async (dir) => {
    const { cap, calls } = rig(dir);
    await writeFile(join(dir, "a.wav"), wav());
    await cap.pollOnce();
    assert.equal(calls.length, 0, "first sight only records the size");
    await cap.pollOnce();
    assert.deepEqual(calls.map((c) => [c.speaker, c.clip.rate, c.clip.channels, c.clip.pcm.length, c.source]), [["dir", 16000, 1, 16000, "dir"]]);
    assert.deepEqual(await names(dir), ["a.wav.done"]);
    await cap.pollOnce();
    await cap.pollOnce();
    assert.equal(calls.length, 1, "never twice");
  });
});

// @spec EARS-CAP-008
test("only regular .wav files count (any case); a file still growing waits until its size settles", async () => {
  await withDir(async (dir) => {
    const { cap, calls } = rig(dir);
    await writeFile(join(dir, "note.txt"), "x");
    await writeFile(join(dir, "UP.WAV"), wav());
    await writeFile(join(dir, "grow.wav"), wav(200));
    await cap.pollOnce();
    await appendFile(join(dir, "grow.wav"), Buffer.alloc(3200));
    await cap.pollOnce();
    assert.deepEqual(await names(dir), ["UP.WAV.done", "grow.wav", "note.txt"]);
    assert.equal(calls.length, 1);
    await cap.pollOnce();
    assert.deepEqual(await names(dir), ["UP.WAV.done", "grow.wav.done", "note.txt"]);
  });
});

// @spec EARS-CAP-009
test("outcomes pick the suffix: not decodable and oversize are .rejected (oversize never read), STT failure is .failed", async () => {
  await withDir(async (dir) => {
    const { cap, calls } = rig(dir, () => ({ heard: false, reason: "stt-error" }), { maxBytes: 20_000 });
    await writeFile(join(dir, "bad.wav"), "not audio");
    await writeFile(join(dir, "big.wav"), wav(1500));
    await writeFile(join(dir, "stt.wav"), wav(300));
    await cap.pollOnce();
    await cap.pollOnce();
    assert.deepEqual(await names(dir), ["bad.wav.rejected", "big.wav.rejected", "stt.wav.failed"]);
    assert.equal(calls.length, 1, "only the decodable, in-cap file reached STT");
  });
});

// @spec EARS-CAP-009
test("a clip that publishes nothing (too short, silence phrase) is still done, not retried", async () => {
  await withDir(async (dir) => {
    const { cap, calls } = rig(dir, { heard: false, reason: "too-short" });
    await writeFile(join(dir, "s.wav"), wav(50));
    await cap.pollOnce();
    await cap.pollOnce();
    assert.deepEqual(await names(dir), ["s.wav.done"]);
    assert.equal(calls.length, 1);
  });
});

// @spec EARS-CAP-009
test("at most INJECT_QUEUE_LIMIT files are taken per poll, in name order, one at a time", async () => {
  await withDir(async (dir) => {
    let active = 0;
    let maxActive = 0;
    const order: number[] = [];
    const hear: HearClip = async (clip) => {
      active++;
      maxActive = Math.max(maxActive, active);
      order.push(clip.pcm.length);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      return { heard: true, text: "ok" };
    };
    const cap = createDirCapture({ path: dir, pollMs: 10, log: silentLog, hear });
    for (let i = 0; i < 10; i++) await writeFile(join(dir, `c${String(i).padStart(2, "0")}.wav`), wavWrap(Buffer.alloc(3200 + i * 2), 16000, 1));
    await cap.pollOnce();
    await cap.pollOnce();
    assert.equal(INJECT_QUEUE_LIMIT, 8);
    assert.equal(order.length, INJECT_QUEUE_LIMIT, "eight taken");
    assert.deepEqual(order, [...order].sort((a, b) => a - b), "in name order");
    assert.equal((await names(dir)).filter((n) => n.endsWith(".done")).length, 8);
    await cap.pollOnce();
    assert.equal(order.length, 10);
    assert.equal(maxActive, 1);
  });
});

// @spec EARS-CAP-009
test("when the rename fails the file is remembered and not read again", async () => {
  await withDir(async (dir) => {
    const { cap, calls } = rig(dir, { heard: true, text: "ok" }, { rename: async () => { throw new Error("read-only"); } });
    await writeFile(join(dir, "a.wav"), wav());
    for (let i = 0; i < 4; i++) await cap.pollOnce();
    assert.equal(calls.length, 1);
    assert.deepEqual(await names(dir), ["a.wav"]);
  });
});

// @spec EARS-CAP-008, EARS-CAP-012
test("start creates a missing directory and polls on a timer until stop; stop leaves no timer behind", async () => {
  await withDir(async (root) => {
    const dir = join(root, "inbox", "nested");
    const { cap, calls } = rig(dir);
    assert.equal(cap.status(), "down");
    await cap.start();
    try {
      assert.equal(existsSync(dir), true);
      assert.equal(cap.status(), "ok");
      await writeFile(join(dir, "a.wav"), wav());
      await waitFor(() => calls.length === 1, "polled file heard");
    } finally {
      await cap.stop();
    }
    assert.equal(cap.status(), "down");
    await writeFile(join(dir, "b.wav"), wav());
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(calls.length, 1, "no polling after stop");
    await rename(join(dir, "b.wav"), join(dir, "b.txt"));
  });
});

// @spec EARS-CAP-012
test("stop waits for the clip in flight", async () => {
  await withDir(async (dir) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered = false;
    const { cap } = rig(dir, { heard: true, text: "ok" }, { hear: async () => { entered = true; await gate; return { heard: true, text: "ok" }; } });
    await writeFile(join(dir, "a.wav"), wav());
    await cap.start();
    try {
      await waitFor(() => entered, "file in STT");
      let stopped = false;
      const stopping = cap.stop().then(() => { stopped = true; });
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(stopped, false);
      release();
      await stopping;
      assert.deepEqual(await names(dir), ["a.wav.done"]);
    } finally {
      release();
      await cap.stop();
    }
  });
});
