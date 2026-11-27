import { test } from "node:test";
import assert from "node:assert/strict";
import { runService, wavWrap } from "@cohost/shared";
import { bootUnit, started, waitFor } from "@cohost/testing";
import { createConnectorService } from "../src/service.js";

const UPLOAD = "0123456789abcdef0123456789abcdef";

// @spec MOD-MAN-018
test("connector-discord boots against a projection of only its declared sections and answers an injected clip with inject.result", async () => {
  // As the entry builds it; the isolation preset turns Discord off, so no client is built and the clip is answered.
  const u = await bootUnit("connector-discord", { start: (deps) => runService({ service: "connector-discord", ...createConnectorService(), ...deps }) });
  try {
    await started(u);
    await u.subscribed("connector-discord");
    u.putUpload(UPLOAD, wavWrap(Buffer.alloc(48_000 * 2 * 2 / 10), 48_000, 2));
    u.inject("inject.request", { id: "boot-1", target: "connector-discord", kind: "audio", uploadId: UPLOAD, contentType: "audio/wav", remember: false });
    await waitFor(() => u.published("inject.result").some((r) => r.id === "boot-1"), "inject.result", 10_000);
    assert.equal(u.published("inject.result").find((r) => r.id === "boot-1")!.ok, true, JSON.stringify(u.published("inject.result")));
    assert.deepEqual(u.exits, []);
  } finally {
    await u.stop();
  }
});
