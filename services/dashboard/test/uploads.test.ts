import { test } from "node:test";
import assert from "node:assert/strict";
import { uploadOptionsFromEnv, uploadMaxBytes } from "../src/uploads.js";

// @spec DASH-UPL-001
test("defaults are 8 MiB image and 25 MiB audio; the env overrides them; junk falls back", () => {
  const d = uploadOptionsFromEnv({});
  assert.equal(d.maxImageBytes, 8 * 1024 * 1024);
  assert.equal(d.maxAudioBytes, 25 * 1024 * 1024);
  const o = uploadOptionsFromEnv({ INJECT_MAX_IMAGE_BYTES: "100", INJECT_MAX_AUDIO_BYTES: "200" });
  assert.deepEqual([o.maxImageBytes, o.maxAudioBytes], [100, 200]);
  for (const bad of ["", "abc", "0", "-5"]) {
    const f = uploadOptionsFromEnv({ INJECT_MAX_IMAGE_BYTES: bad, INJECT_MAX_AUDIO_BYTES: bad, INJECT_TTL_MS: bad });
    assert.deepEqual([f.maxImageBytes, f.maxAudioBytes, f.ttlMs], [d.maxImageBytes, d.maxAudioBytes, d.ttlMs], bad);
  }
});

// @spec DASH-UPL-001
test("uploadMaxBytes picks the cap for the kind", () => {
  const o = { maxImageBytes: 1, maxAudioBytes: 2, ttlMs: 3 };
  assert.equal(uploadMaxBytes(o, "image"), 1);
  assert.equal(uploadMaxBytes(o, "audio"), 2);
});
