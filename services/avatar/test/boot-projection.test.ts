import { test } from "node:test";
import assert from "node:assert/strict";
import { bootUnit, started, waitFor } from "@cohost/testing";
import { runAvatar, type AvatarBus } from "../src/boot.js";

// @spec MOD-MAN-018
test("avatar boots against a projection of only its declared sections and documents and answers a brain.say with avatar.state", async () => {
  const u = await bootUnit<AvatarBus>("avatar", { start: (deps) => runAvatar(deps) });
  try {
    await started(u);
    await u.subscribed("avatar");
    u.inject("brain.say", { id: "boot-1", text: "Hello chat!", emotion: "happy", injected: true, remember: false });
    await waitFor(() => u.published("avatar.state").some((s) => s.emotion === "happy"), "avatar.state", 10_000);
    assert.deepEqual(u.exits, []);
  } finally {
    await u.stop();
  }
});
