import { test } from "node:test";
import assert from "node:assert/strict";
import { bootFailure, bootUnit, started, waitFor } from "@cohost/testing";
import { runAffect, type AffectBus } from "../src/main.js";

// @spec MOD-MAN-018
test("affect boots against a projection of only its declared sections and answers a chat.message with affect.state", async () => {
  const u = await bootUnit<AffectBus>("affect", { start: (deps) => runAffect(deps) });
  try {
    await started(u);
    await u.subscribed("affect");
    u.inject("chat.message", { platform: "twitch", user: "viewer", text: "Coco this is amazing, I love it!!", isMod: false, isSub: true, injected: true, remember: false });
    await waitFor(() => u.published("affect.state").length > 0, "affect.state", 10_000);
    assert.deepEqual(u.exits, []);
  } finally {
    await u.stop();
  }
});

// @spec MOD-MAN-018
test("a projection missing a declared section fails the boot, naming the section", async () => {
  const u = await bootUnit<AffectBus>("affect", { omit: ["brain.affect"], start: (deps) => runAffect(deps) });
  try {
    const failure = await bootFailure(u);
    assert.match(failure, /read the settings section brain\.affect, which its projection does not hold/);
    assert.deepEqual(u.exits, [1]);
  } finally {
    await u.stop();
  }
});
