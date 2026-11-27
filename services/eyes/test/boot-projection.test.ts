import { test } from "node:test";
import assert from "node:assert/strict";
import OBSWebSocket from "obs-websocket-js";
import { runService } from "@cohost/shared";
import { bootUnit, started, waitFor } from "@cohost/testing";
import { eyesService } from "../src/service.js";

/** A 1x1 PNG: the injected image's bytes. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

// @spec MOD-MAN-018
test("eyes boots against a projection of only its declared sections and answers an injected image with vision.summary and inject.result", async () => {
  const u = await bootUnit("eyes", {
    start: (deps) => {
      // As the entry builds it; the isolation preset turns vision off and the describer to the stub, so OBS is never reached.
      const svc = eyesService({ obs: new OBSWebSocket() as never });
      return runService({ service: "eyes", health: (cfg) => svc.health(cfg), main: svc.main, ...deps });
    },
  });
  try {
    await started(u);
    await u.subscribed("eyes");
    u.putUpload("0123456789abcdef0123456789abcdef", PNG);
    u.inject("inject.request", { id: "boot-1", target: "eyes", kind: "image", uploadId: "0123456789abcdef0123456789abcdef", contentType: "image/png", remember: false });
    await waitFor(() => u.published("inject.result").some((r) => r.id === "boot-1"), "inject.result", 10_000);
    assert.equal(u.published("inject.result").find((r) => r.id === "boot-1")!.ok, true, JSON.stringify(u.published("inject.result")));
    assert.ok(u.published("vision.summary").length > 0, "vision.summary");
    assert.deepEqual(u.exits, []);
  } finally {
    await u.stop();
  }
});
