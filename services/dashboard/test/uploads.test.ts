import { test } from "node:test";
import assert from "node:assert/strict";
import { UploadStore, uploadOptionsFromEnv } from "../src/uploads.js";

function store(over: Partial<ConstructorParameters<typeof UploadStore>[0]> = {}, clock = { t: 0 }) {
  return { clock, s: new UploadStore({ maxImageBytes: 100, maxAudioBytes: 200, ttlMs: 1000, maxEntries: 16, maxTotalBytes: 10_000, now: () => clock.t, ...over }) };
}

test("ids are 128-bit hex and unique; bytes and type round-trip", () => {
  const { s } = store();
  const a = s.put("image", "image/png", Buffer.from("abc"));
  const b = s.put("image", "image/png", Buffer.from("abc"));
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, b);
  assert.equal(s.get(a)!.data.toString(), "abc");
  assert.equal(s.get(a)!.contentType, "image/png");
});

test("per-kind size cap", () => {
  const { s } = store();
  assert.throws(() => s.put("image", "image/png", Buffer.alloc(101)), /exceeds/);
  s.put("audio", "audio/wav", Buffer.alloc(150));
});

test("entries expire after the TTL", () => {
  const { s, clock } = store();
  const id = s.put("image", "image/png", Buffer.from("x"));
  clock.t = 999;
  assert.ok(s.get(id));
  clock.t = 1000;
  assert.equal(s.get(id), undefined);
  assert.equal(s.size, 0);
});

test("sweep drops expired entries", () => {
  const { s, clock } = store();
  s.put("image", "image/png", Buffer.from("x"));
  clock.t = 5000;
  s.sweep();
  assert.equal(s.size, 0);
});

test("the 17th upload evicts the oldest", () => {
  const { s } = store();
  const ids = Array.from({ length: 17 }, () => s.put("image", "image/png", Buffer.from("x")));
  assert.equal(s.size, 16);
  assert.equal(s.get(ids[0]!), undefined);
  assert.ok(s.get(ids[16]!));
});

test("total byte cap evicts oldest first", () => {
  const { s } = store({ maxTotalBytes: 250, maxAudioBytes: 200 });
  const a = s.put("audio", "audio/wav", Buffer.alloc(100));
  const b = s.put("audio", "audio/wav", Buffer.alloc(100));
  const c = s.put("audio", "audio/wav", Buffer.alloc(100));
  assert.equal(s.get(a), undefined);
  assert.ok(s.get(b) && s.get(c));
});

test("env overrides and defaults", () => {
  const d = uploadOptionsFromEnv({});
  assert.deepEqual([d.maxImageBytes, d.maxAudioBytes, d.ttlMs, d.maxEntries, d.maxTotalBytes], [8388608, 26214400, 600000, 16, 64 * 1024 * 1024]);
  const o = uploadOptionsFromEnv({ INJECT_MAX_IMAGE_BYTES: "10", INJECT_MAX_AUDIO_BYTES: "20", INJECT_TTL_MS: "30" });
  assert.deepEqual([o.maxImageBytes, o.maxAudioBytes, o.ttlMs], [10, 20, 30]);
  assert.equal(uploadOptionsFromEnv({ INJECT_TTL_MS: "junk" }).ttlMs, 600000);
});
