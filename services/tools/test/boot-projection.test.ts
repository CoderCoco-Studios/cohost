import { test } from "node:test";
import assert from "node:assert/strict";
import { bootUnit, started, waitFor } from "@cohost/testing";
import { runTools, type ToolsBus } from "../src/main.js";

// @spec MOD-MAN-018
test("tools boots against a projection of only its declared sections and answers an injected tool call", async () => {
  const u = await bootUnit<ToolsBus>("tools", { start: (deps) => runTools(deps) });
  try {
    await started(u);
    await u.subscribed("tools");
    u.inject("inject.request", { id: "boot-1", target: "tools", kind: "text", text: JSON.stringify({ tool: "clock", arguments: {} }), remember: false });
    await waitFor(() => u.published("inject.result").some((r) => r.id === "boot-1"), "inject.result", 10_000);
    assert.equal(u.published("inject.result").find((r) => r.id === "boot-1")!.ok, true, JSON.stringify(u.published("inject.result")));
    await waitFor(() => u.published("tool.result").length > 0, "tool.result", 10_000);
    assert.deepEqual(u.exits, []);
  } finally {
    await u.stop();
  }
});
