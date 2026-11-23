import { test } from "node:test";
import assert from "node:assert/strict";
import { runHeartbeat } from "@cohost/testing";
import { ChatError, ImageDataError } from "@cohost/llm";
import { EyesHealth } from "../src/health.js";

// @spec EYES-HEALTH-001
test("vision disabled: mode off and both deps n/a", async () => {
  const hbs = await runHeartbeat(new EyesHealth(false, () => false).spec);
  assert.equal(hbs[1]!.mode, "off");
  assert.deepEqual(hbs[1]!.deps, { obs: "n/a", vision: "n/a" });
  assert.equal(hbs[1]!.state, "ready");
});

// @spec EYES-HEALTH-002, EYES-HEALTH-003, EYES-HEALTH-004
test("enabled: obs follows the connection, vision follows describe calls", async () => {
  let obs = true;
  const h = new EyesHealth(true, () => obs);
  assert.deepEqual((await runHeartbeat(h.spec))[1]!.deps, { obs: "ok", vision: "ok" });
  await assert.rejects(h.track(async () => { throw new Error("boom"); })("b64", ""));
  obs = false;
  const hbs = await runHeartbeat(h.spec);
  assert.deepEqual(hbs[1]!.deps, { obs: "down", vision: "down" });
  assert.equal(hbs[1]!.state, "degraded");
  assert.equal(hbs[1]!.mode, "live");
});

// @spec EYES-STUB-002
test("stub engine: mode mock with vision n/a while enabled, mode off when vision is disabled", async () => {
  const on = await runHeartbeat(new EyesHealth(true, () => true, "stub").spec);
  assert.equal(on[1]!.mode, "mock");
  assert.deepEqual(on[1]!.deps, { obs: "ok", vision: "n/a" });
  assert.equal(on[1]!.state, "ready");
  const off = await runHeartbeat(new EyesHealth(false, () => false, "stub").spec);
  assert.equal(off[1]!.mode, "off");
  assert.deepEqual(off[1]!.deps, { obs: "n/a", vision: "n/a" });
});

// @spec EYES-HEALTH-003
test("vision recovers to ok after a successful describe following a failure", async () => {
  const h = new EyesHealth(true, () => true);
  await assert.rejects(h.track(async () => { throw new Error("boom"); })("b64", ""));
  assert.equal((await runHeartbeat(h.spec))[1]!.deps!.vision, "down");
  await h.track(async () => "fine")("b64", "");
  const hbs = await runHeartbeat(h.spec);
  assert.equal(hbs[1]!.deps!.vision, "ok");
  assert.equal(hbs[1]!.state, "ready");
});

const visionOf = async (h: EyesHealth) => (await runHeartbeat(h.spec))[1]!.deps!.vision;
const fail = (h: EyesHealth, err: unknown) => assert.rejects(h.track(async () => { throw err; })("b64", ""));

// @spec EYES-PROV-006, EYES-HEALTH-003
test("every outage-class failure sets deps.vision down: dropped connection, timeout, 5xx, 401, 403, 404, 429, other statuses, and no status at all", async () => {
  const outages: [string, unknown][] = [
    ["connect", new ChatError("connect", "cannot reach openai at http://x: refused")],
    ["500", new ChatError("http", "openai chat 500: x", 500)],
    ["503", new ChatError("http", "openai chat 503: x", 503)],
    ["401", new ChatError("http", "openai chat 401: x", 401)],
    ["403", new ChatError("http", "openai chat 403: x", 403)],
    ["404", new ChatError("http", "ollama chat 404: x", 404)],
    ["429", new ChatError("http", "anthropic chat 429: x", 429)],
    ["any other failed status", new ChatError("http", "openai chat 413: x", 413)],
    ["not_configured, no status", new ChatError("not_configured", "the anthropic provider is not configured: llm.claude.api_key is not set")],
    ["stream, no status", new ChatError("stream", "openai stream: cut")],
    ["timeout", new Error("vision model did not answer within 30000 ms")],
    ["a plain error with no status", new Error("boom")],
    ["a TypeError from a dropped socket (undici: terminated)", new TypeError("terminated")],
  ];
  for (const [name, err] of outages) {
    const h = new EyesHealth(true, () => true, "openai");
    await fail(h, err);
    assert.equal(await visionOf(h), "down", name);
  }
});

// @spec EYES-PROV-006, EYES-PROV-007
test("a 400 or 422 for one frame leaves deps.vision as it was, ok or down", async () => {
  for (const status of [400, 422]) {
    const bad = new ChatError("http", `openai chat ${status}: bad frame`, status);
    const ok = new EyesHealth(true, () => true, "openai");
    await fail(ok, bad);
    assert.equal(await visionOf(ok), "ok", `${status} from ok`);
    const down = new EyesHealth(true, () => true, "openai");
    await fail(down, new ChatError("http", "openai chat 503: x", 503));
    await fail(down, bad);
    assert.equal(await visionOf(down), "down", `${status} from down`);
  }
});

// @spec EYES-PROV-007
test("a 400 or 422 still rejects with the provider's own error, so that look or injection fails", async () => {
  const h = new EyesHealth(true, () => true, "openai");
  const err = new ChatError("http", "openai chat 422: bad frame", 422);
  await assert.rejects(h.track(async () => { throw err; })("b64", ""), (e) => e === err);
});

// @spec EYES-HEALTH-007
test("vision disabled: an injected image's failure, outage or not, leaves deps.vision n/a", async () => {
  for (const err of [new ChatError("http", "openai chat 503: x", 503), new Error("boom")]) {
    const h = new EyesHealth(false, () => false, "openai");
    await fail(h, err);
    const hbs = await runHeartbeat(h.spec);
    assert.deepEqual(hbs[1]!.deps, { obs: "n/a", vision: "n/a" });
    assert.equal(hbs[1]!.mode, "off");
  }
});

// @spec EYES-HEALTH-003, EYES-STUB-002
test("the stub provider reports vision n/a whatever happens", async () => {
  const h = new EyesHealth(true, () => true, "stub");
  await fail(h, new Error("boom"));
  assert.equal(await visionOf(h), "n/a");
});

// @spec EYES-HEALTH-001, EYES-HEALTH-002
test("every provider reports mode live while enabled and off while disabled, with the dependency named vision", async () => {
  for (const provider of ["ollama", "openai", "anthropic", "bedrock"] as const) {
    const on = (await runHeartbeat(new EyesHealth(true, () => true, provider).spec))[1]!;
    assert.equal(on.mode, "live", provider);
    assert.deepEqual(on.deps, { obs: "ok", vision: "ok" }, provider);
    const off = (await runHeartbeat(new EyesHealth(false, () => true, provider).spec))[1]!;
    assert.equal(off.mode, "off", provider);
    assert.deepEqual(off.deps, { obs: "n/a", vision: "n/a" }, provider);
  }
});

// @spec EYES-PROV-007, EYES-PROV-006
test("an ImageDataError from the model layer for one frame (image data in no supported format) leaves deps.vision as it was", async () => {
  const bad = new ImageDataError("image data is not JPEG, PNG, GIF or WebP");
  const ok = new EyesHealth(true, () => true, "openai");
  await fail(ok, bad);
  assert.equal(await visionOf(ok), "ok");
  const down = new EyesHealth(true, () => true, "openai");
  await fail(down, new ChatError("http", "openai chat 503: x", 503));
  await fail(down, bad);
  assert.equal(await visionOf(down), "down");
});

// @spec EYES-GAP-002, EYES-GAP-003
test("a configuration gap starts deps.vision down", async () => {
  const h = new EyesHealth(true, () => true, "anthropic", { gap: "the anthropic provider is not configured: llm.claude.api_key is not set" });
  const hb = (await runHeartbeat(h.spec))[1]!;
  assert.equal(hb.deps!.vision, "down");
});
