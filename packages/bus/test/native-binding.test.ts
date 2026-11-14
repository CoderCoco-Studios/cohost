// What @cohost/bus takes from the native binding that needs no Redis: the codec helpers, the constants, the tag grammar and
// the naming (BUS-NAT-RS-*, BUS-NAT-TRN-013). Fails until Phase 6 re-exports them from native.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as bus from "../src/index.js";
import * as native from "../src/native.js";
import { FakeTransport, busWith } from "./native-helpers.js";

const fields = ["v", "1", "epoch", "1", "seq", "0", "rate", "16000", "ch", "1", "pcm", Buffer.alloc(4)];

// @spec BUS-NAT-TRN-013, BUS-NAT-RS-003
test("encodeFrame and decodeFrame are the binding's, exported under those names, and are synchronous", () => {
  assert.equal(bus.encodeFrame, native.encodeFrame);
  assert.equal(bus.decodeFrame, native.decodeFrame);
  assert.equal(bus.tagProblem, native.tagProblem);
  const decoded = bus.decodeFrame(fields);
  assert.ok(!(decoded instanceof Promise));
  assert.equal(decoded.ok, true);
  const encoded = bus.encodeFrame({ epoch: 1, seq: 0, rate: 16000, ch: 1, pcm: Buffer.alloc(4) });
  assert.ok(Array.isArray(encoded));
  assert.deepEqual(encoded.slice(0, 10), ["v", "1", "epoch", "1", "seq", "0", "rate", "16000", "ch", "1"]);
});

// @spec BUS-NAT-RS-004
test("the exported constants have the crate's values", () => {
  assert.equal(bus.FRAME_VERSION, 1);
  assert.equal(bus.MAX_FRAME_BYTES, 65536);
  assert.deepEqual(bus.AUDIO_MAXLEN, { in: 3000, out: 1500 });
  assert.equal(bus.AUDIO_STREAM_TTL_MS, 60000);
  assert.equal(bus.LEASE_INTERVALS, 3);
  assert.equal(bus.REGISTRATION_VERSION, 1);
  assert.equal(bus.DEFAULT_CONNECTOR_INTERVAL_MS, 5000);
  assert.equal(bus.HEALTH_MAXLEN, 1000);
  for (const name of ["FRAME_VERSION", "MAX_FRAME_BYTES", "AUDIO_MAXLEN", "AUDIO_STREAM_TTL_MS", "LEASE_INTERVALS", "REGISTRATION_VERSION", "DEFAULT_CONNECTOR_INTERVAL_MS"]) {
    assert.deepEqual((native as Record<string, unknown>)[name], (bus as Record<string, unknown>)[name], `${name} comes from the binding`);
  }
});

// @spec BUS-NAT-RS-005
test("the tag grammar (TAG_PATTERN, RESERVED_TAGS, tagProblem) is the binding's", () => {
  assert.equal(bus.TAG_PATTERN.source, "^[a-z][a-z0-9-]{0,31}$");
  assert.deepEqual([...bus.RESERVED_TAGS], ["http", "dir", "dashboard", "mouth", "dryrun", "file"]);
  assert.equal(bus.tagProblem("discord"), null);
  assert.match(bus.tagProblem("Bad Tag")!, /does not match/);
  assert.match(bus.tagProblem("mouth")!, /reserved/);
  assert.equal(native.tagProblem("discord"), null);
  assert.match(native.tagProblem("mouth")!, /reserved/);
});

// @spec BUS-NAT-RS-006
test("connectorKey and audioStream return <prefix>:connector:<id> and <prefix>:audio.<dir>.<tag> from the crate", async () => {
  const { bus: b } = busWith(new FakeTransport(), { streamPrefix: "p1" });
  assert.equal(b.connectorKey("disc"), "p1:connector:disc");
  assert.equal(b.audioStream("in", "discord"), "p1:audio.in.discord");
  assert.equal(b.audioStream("out", "mouth-out"), "p1:audio.out.mouth-out");
  assert.equal(typeof (native as Record<string, unknown>).connectorKey, "function", "the names are built by the binding");
  await b.stop();
});

// @spec BUS-NAT-RS-007
test("parseRegistration, findOffer, findReady, capabilityDirection, FrameSequencer, FrameTracker, ConnectorRegistrar, watchConnectors and ConnectorRegistry stay TypeScript exports", () => {
  for (const name of ["parseRegistration", "findOffer", "findReady", "capabilityDirection", "FrameSequencer", "FrameTracker", "ConnectorRegistrar", "watchConnectors", "ConnectorRegistry"]) {
    assert.equal(typeof (bus as Record<string, unknown>)[name], "function", name);
    assert.ok(!(name in native), `${name} is not taken from the binding`);
  }
});
