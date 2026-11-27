import { test } from "node:test";
import assert from "node:assert/strict";
import { bootUnit, started, waitFor } from "@cohost/testing";
import { runSalience, type SalienceBus } from "../src/main.js";

// @spec MOD-MAN-018
test("salience boots against a projection of only its declared sections and focuses a chat.message that names the co-host", async () => {
  const u = await bootUnit<SalienceBus>("salience", { start: (deps) => runSalience(deps) });
  try {
    await started(u);
    await u.subscribed("salience");
    u.inject("chat.message", { platform: "twitch", user: "viewer", text: "Coco, what game are we playing today?", isMod: false, isSub: false, mentionsCohost: true, injected: true, remember: false });
    await waitFor(() => u.published("attention.focus").length > 0, "attention.focus", 10_000);
    assert.equal(u.published("attention.focus")[0]!.focus?.kind, "chat");
    assert.deepEqual(u.exits, []);
  } finally {
    await u.stop();
  }
});
