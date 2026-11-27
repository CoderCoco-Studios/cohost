import { test } from "node:test";
import assert from "node:assert/strict";
import { bootUnit, started, waitFor } from "@cohost/testing";
import { runVoice, type VoiceBus } from "../src/boot.js";

// @spec MOD-MAN-018
test("voice boots against a projection of only its declared sections and answers a brain.say with voice.utterance", async () => {
  const u = await bootUnit<VoiceBus>("voice", { start: (deps) => runVoice({ ...deps, port: 0, publicUrl: "http://127.0.0.1:0" }) });
  try {
    await started(u);
    await u.subscribed("voice");
    u.inject("brain.say", { id: "boot-1", text: "Hello chat!", emotion: "happy", injected: true, remember: false });
    await waitFor(() => u.published("voice.utterance").some((e) => e.id === "boot-1"), "voice.utterance", 10_000);
    assert.deepEqual(u.exits, []);
  } finally {
    await u.stop();
  }
});
