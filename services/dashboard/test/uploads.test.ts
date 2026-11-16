import { test } from "node:test";
import assert from "node:assert/strict";
import { testConfig } from "@cohost/testing";
import { uploadLimits, uploadMaxBytes } from "../src/uploads.js";

// @spec DASH-UPL-001, DASH-UPL-002
test("the caps and the expiry come from dashboard.inject of the loaded config: 8 MiB image, 25 MiB audio, 300000 ms by default", () => {
  const d = uploadLimits(testConfig().dashboard.inject);
  assert.deepEqual(d, { maxImageBytes: 8 * 1024 * 1024, maxAudioBytes: 25 * 1024 * 1024, ttlMs: 300_000 });
  const o = uploadLimits(testConfig({ dashboard: { inject: { max_image_bytes: 100, max_audio_bytes: 200, ttl_ms: 5000 } } }).dashboard.inject);
  assert.deepEqual(o, { maxImageBytes: 100, maxAudioBytes: 200, ttlMs: 5000 });
});

// @spec DASH-UPL-001, DASH-UPL-002
test("a value that is not a positive integer fails the config at load, and no INJECT_* variable is read", () => {
  for (const bad of [0, -5, 1.5]) assert.throws(() => testConfig({ dashboard: { inject: { max_image_bytes: bad } } }), /max_image_bytes/, String(bad));
  assert.throws(() => testConfig({ dashboard: { inject: { ttl_ms: 0 } } }), /ttl_ms/);
  Object.assign(process.env, { INJECT_MAX_IMAGE_BYTES: "1", INJECT_MAX_AUDIO_BYTES: "2", INJECT_TTL_MS: "3" });
  try { assert.deepEqual(uploadLimits(testConfig().dashboard.inject), { maxImageBytes: 8388608, maxAudioBytes: 26214400, ttlMs: 300000 }); }
  finally { for (const k of ["INJECT_MAX_IMAGE_BYTES", "INJECT_MAX_AUDIO_BYTES", "INJECT_TTL_MS"]) delete process.env[k]; }
});

// @spec DASH-UPL-001
test("uploadMaxBytes picks the cap for the kind", () => {
  const o = { maxImageBytes: 1, maxAudioBytes: 2, ttlMs: 3 };
  assert.equal(uploadMaxBytes(o, "image"), 1);
  assert.equal(uploadMaxBytes(o, "audio"), 2);
});
