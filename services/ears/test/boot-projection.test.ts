import { test } from "node:test";
import assert from "node:assert/strict";
import { runService, wavWrap } from "@cohost/shared";
import { bootUnit, started, waitFor } from "@cohost/testing";
import { createEarsService } from "../src/service.js";

const UPLOAD = "0123456789abcdef0123456789abcdef";

// @spec MOD-MAN-018
test("ears boots against a projection of only its declared sections and answers an injected clip with speech.heard and inject.result", async () => {
  // As the entry builds it; the isolation preset lists no listening source and the stub speech engine.
  const u = await bootUnit("ears", { start: (deps) => runService({ service: "ears", ...createEarsService(), ...deps }) });
  try {
    await started(u);
    await u.subscribed("ears");
    u.putUpload(UPLOAD, wavWrap(Buffer.alloc(16_000 * 2 / 5), 16_000, 1));
    u.inject("inject.request", { id: "boot-1", target: "ears", kind: "audio", uploadId: UPLOAD, contentType: "audio/wav", meta: { user: "viewer" }, remember: false });
    await waitFor(() => u.published("inject.result").some((r) => r.id === "boot-1"), "inject.result", 10_000);
    assert.equal(u.published("inject.result").find((r) => r.id === "boot-1")!.ok, true, JSON.stringify(u.published("inject.result")));
    assert.ok(u.published("speech.heard").some((s) => s.speaker === "viewer"), "speech.heard");
    assert.deepEqual(u.exits, []);
  } finally {
    await u.stop();
  }
});
