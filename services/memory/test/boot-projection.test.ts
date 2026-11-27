import { test } from "node:test";
import assert from "node:assert/strict";
import { bootUnit, started, waitFor } from "@cohost/testing";
import { runMemory, type MemoryBus } from "../src/main.js";

// @spec MOD-MAN-018
test("memory boots against a projection of only its declared sections and documents and answers a memory.recall.request", async () => {
  const u = await bootUnit<MemoryBus>("memory", { start: (deps) => runMemory(deps) });
  try {
    await started(u);
    await u.subscribed("memory-recall");
    u.inject("memory.recall.request", { id: "boot-1", query: "what game did we play" });
    await waitFor(() => u.published("memory.recall.reply").some((r) => r.id === "boot-1"), "memory.recall.reply", 10_000);
    assert.deepEqual(u.exits, []);
  } finally {
    await u.stop();
  }
});
