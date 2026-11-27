import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { runService } from "@cohost/shared";
import { bootUnit, started, waitFor } from "@cohost/testing";
import { chatService } from "../src/service.js";

// @spec MOD-MAN-018
test("chat boots against a projection of only its declared sections and answers an injected text with chat.message and inject.result", async () => {
  const u = await bootUnit("chat", {
    start: (deps) => {
      // As the entry builds it, with an ended stdin so the fake source (the isolation preset) runs its script.
      const svc = chatService({ stdin: Readable.from([]), exit: deps.exit });
      return runService({ service: "chat", health: (cfg) => svc.health(cfg), main: svc.main, ...deps });
    },
  });
  try {
    await started(u);
    await u.subscribed("chat");
    u.inject("inject.request", { id: "boot-1", target: "chat", kind: "text", text: "hello from the boot test", meta: { user: "viewer" }, remember: false });
    await waitFor(() => u.published("inject.result").some((r) => r.id === "boot-1"), "inject.result", 10_000);
    assert.equal(u.published("inject.result").find((r) => r.id === "boot-1")!.ok, true);
    assert.ok(u.published("chat.message").some((m) => m.text === "hello from the boot test"));
    assert.deepEqual(u.exits, []);
  } finally {
    await u.stop();
  }
});
