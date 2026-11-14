// What @cohost/bus defines in TypeScript and takes from the native binding: the codec helpers, constants and tag grammar
// are TypeScript (connector.ts), the binding serves the events path only (BUS-NAT-RS-*, BUS-NAT-TRN-013).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as bus from "../src/index.js";
import * as native from "../src/native.js";
import { FakeTransport, busWith } from "./native-helpers.js";

const fields = ["v", "1", "epoch", "1", "seq", "0", "rate", "16000", "ch", "1", "pcm", Buffer.alloc(4)];

// @spec BUS-NAT-TRN-013, BUS-NAT-RS-003
test("encodeFrame and decodeFrame are TypeScript exports of @cohost/bus, not the binding's, and are synchronous", () => {
  for (const name of ["encodeFrame", "decodeFrame", "tagProblem", "TAG_PATTERN", "RESERVED_TAGS", "audioStream", "FRAME_VERSION", "MAX_FRAME_BYTES", "AUDIO_MAXLEN"]) {
    assert.ok(!(name in native), `${name} is not exported by native.ts`);
  }
  const decoded = bus.decodeFrame(fields);
  assert.ok(!(decoded instanceof Promise));
  assert.equal(decoded.ok, true);
  const encoded = bus.encodeFrame({ epoch: 1, seq: 0, rate: 16000, ch: 1, pcm: Buffer.alloc(4) });
  assert.ok(Array.isArray(encoded));
  assert.deepEqual(encoded.slice(0, 10), ["v", "1", "epoch", "1", "seq", "0", "rate", "16000", "ch", "1"]);
});

// @spec BUS-NAT-RS-004
test("the exported constants have the specified values; HEALTH_MAXLEN is the crate's", () => {
  assert.equal(bus.FRAME_VERSION, 1);
  assert.equal(bus.MAX_FRAME_BYTES, 65536);
  assert.deepEqual(bus.AUDIO_MAXLEN, { in: 3000, out: 1500 });
  assert.equal(bus.AUDIO_STREAM_TTL_MS, 60000);
  assert.equal(bus.LEASE_INTERVALS, 3);
  assert.equal(bus.REGISTRATION_VERSION, 1);
  assert.equal(bus.DEFAULT_CONNECTOR_INTERVAL_MS, 5000);
  assert.equal(bus.HEALTH_MAXLEN, 1000);
  assert.equal(bus.HEALTH_MAXLEN, native.HEALTH_MAXLEN, "HEALTH_MAXLEN comes from the binding");
  for (const name of ["LEASE_INTERVALS", "REGISTRATION_VERSION", "DEFAULT_CONNECTOR_INTERVAL_MS"]) {
    assert.ok(!(name in native), `${name} is TypeScript`);
  }
});

// @spec BUS-NAT-RS-005
test("the tag grammar (TAG_PATTERN, RESERVED_TAGS, tagProblem) is TypeScript in connector.ts", () => {
  assert.equal(bus.TAG_PATTERN.source, "^[a-z][a-z0-9-]{0,31}$");
  assert.deepEqual([...bus.RESERVED_TAGS], ["http", "dir", "dashboard", "mouth", "dryrun", "file"]);
  assert.equal(bus.tagProblem("discord"), null);
  assert.match(bus.tagProblem("Bad Tag")!, /does not match/);
  assert.match(bus.tagProblem("mouth")!, /reserved/);
  assert.ok(!("tagProblem" in native));
});

// @spec BUS-NAT-RS-006
test("connectorKey is built by the crate (synchronously) and audioStream by the frames path in TypeScript", async () => {
  const { bus: b } = busWith(new FakeTransport(), { streamPrefix: "p1" });
  assert.equal(b.connectorKey("disc"), "p1:connector:disc");
  assert.equal(b.audioStream("in", "discord"), "p1:audio.in.discord");
  assert.equal(b.audioStream("out", "mouth-out"), "p1:audio.out.mouth-out");
  assert.equal(typeof (native as Record<string, unknown>).connectorKey, "function", "the connector key is built by the binding");
  assert.equal(native.connectorKey("p1", "disc"), "p1:connector:disc");
  assert.ok(!(native.connectorKey("p1", "disc") instanceof Promise));
  await b.stop();
});

// @spec BUS-NAT-API-010, BUS-NAT-FRM-007
test("native.ts is the only file that imports the addon, and the frames path never calls it", () => {
  for (const f of ["frames.ts", "connector.ts", "index.ts", "transport.ts", "registrar.ts"]) {
    const src = readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
    assert.ok(!/\.node["']/.test(src), `${f} does not load the addon`);
  }
  const frames = readFileSync(new URL("../src/frames.ts", import.meta.url), "utf8");
  assert.ok(!/native\.js/.test(frames), "frames.ts does not import native.ts");
});

// @spec BUS-NAT-RS-007
test("parseRegistration, findOffer, findReady, capabilityDirection, FrameSequencer, FrameTracker, ConnectorRegistrar, watchConnectors and ConnectorRegistry stay TypeScript exports", () => {
  for (const name of ["parseRegistration", "findOffer", "findReady", "capabilityDirection", "FrameSequencer", "FrameTracker", "ConnectorRegistrar", "watchConnectors", "ConnectorRegistry"]) {
    assert.equal(typeof (bus as Record<string, unknown>)[name], "function", name);
    assert.ok(!(name in native), `${name} is not taken from the binding`);
  }
});
