import { test } from "node:test";
import assert from "node:assert/strict";
import { runService, wavWrap } from "@cohost/shared";
import { bootUnit, started, waitFor } from "@cohost/testing";
import { createMouth, type MouthBus } from "../src/mouth.js";

/**
 * Mouth's declared test input is `brain.say`, which reaches it as the `voice.utterance` voice synthesises from it (the
 * manifest lists voice in mouth's `uses`); with no voice in this test, the utterance is published directly and its audio is
 * fetched from a fake backend.
 */
// @spec MOD-MAN-018
test("mouth boots against a projection of only its declared sections and plays a line on the dry-run output", async () => {
  const fetched: string[] = [];
  const fetchAudio = async (url: string): Promise<Buffer> => { fetched.push(url); return wavWrap(Buffer.alloc(4_800), 24_000, 1); };
  // As the entry builds it; the isolation preset turns the Discord output off and the dry-run output on.
  const u = await bootUnit<MouthBus>("mouth", {
    start: (deps) => {
      const mouth = createMouth({ fetchAudio });
      return runService<MouthBus>({ service: "mouth", health: mouth.health, main: mouth.main, ...deps });
    },
  });
  try {
    await started(u);
    await u.subscribed("mouth");
    u.inject("voice.utterance", {
      id: "boot-1", seq: 0, text: "Hello chat!", emotion: "happy", durationMs: 100, envelopeHz: 50, envelope: [0, 0, 0, 0, 0],
      audioUrl: "/audio/boot-1-0.wav", sampleRate: 24_000,
    });
    await waitFor(() => u.published("voice.done").some((d) => d.id === "boot-1"), "voice.done", 10_000);
    assert.ok(u.published("voice.playing").some((p) => p.id === "boot-1"), "voice.playing");
    assert.deepEqual(u.exits, []);
  } finally {
    await u.stop();
  }
});
