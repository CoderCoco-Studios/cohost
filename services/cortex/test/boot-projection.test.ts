import { test } from "node:test";
import assert from "node:assert/strict";
import { bootUnit, started, waitFor } from "@cohost/testing";
import { runCortex, type CortexBus } from "../src/main.js";

// @spec MOD-MAN-018
test("cortex boots against a projection of only its declared sections and documents and answers an attention.focus with brain.say", async () => {
  const u = await bootUnit<CortexBus>("cortex", { start: (deps) => runCortex(deps) });
  try {
    await started(u);
    await u.subscribed("cortex");
    u.inject("attention.focus", { reason: "mention", score: 1, focus: { kind: "chat", who: "viewer", text: "Coco, say hi to chat!", mention: true } });
    await waitFor(() => u.published("brain.say").length > 0, "brain.say", 10_000);
    assert.ok(u.published("brain.status").length > 0, "brain.status reports the turn");
    assert.deepEqual(u.exits, []);
  } finally {
    await u.stop();
  }
});
