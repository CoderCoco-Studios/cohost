// Shared contract fixtures: the TS codecs and the Rust codec (crates/cohost-bus/tests/contract.rs) read the same files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  EventPayloads, parseRegistration, decodeFrame, tagProblem, Bus, FRAME_VERSION, MAX_FRAME_BYTES, AUDIO_MAXLEN, AUDIO_STREAM_TTL_MS,
  LEASE_INTERVALS, REGISTRATION_VERSION, DEFAULT_CONNECTOR_INTERVAL_MS,
} from "../src/index.js";
import { FakeTransport, FakeFrameTransport } from "../../testing/src/fake-transport.js";

const root = new URL("../fixtures/contract/", import.meta.url).pathname;
const json = (p: string): any => JSON.parse(readFileSync(p, "utf8"));
const files = (dir: string): string[] => {
  try { return readdirSync(join(root, dir)).filter((f) => f.endsWith(".json")).sort().map((f) => join(root, dir, f)); } catch { return []; }
};
const eventTypes = (): string[] => { try { return readdirSync(join(root, "events")).sort(); } catch { return []; } };

/** A frame fixture's value: a string, or `{ "base64": ... }` for binary. */
const fieldValue = (v: string | { base64: string }): string | Buffer => (typeof v === "string" ? v : Buffer.from(v.base64, "base64"));
const wireFields = (fields: [string, string | { base64: string }][]): (string | Buffer)[] => fields.flatMap(([k, v]) => [k, fieldValue(v)]);
const expectedFrame = (e: any): unknown => (e.ok ? { ok: true, frame: { ...e.frame, pcm: Buffer.from(e.frame.pcm.base64, "base64") } } : e);

// @spec BUS-NAT-FIX-001
test("the fixture directory holds events/<type>/<case>.json, registration/<case>.json, frames/<case>.json, tags/<case>.json and constants.json of the specified shapes", () => {
  assert.ok(statSync(root).isDirectory(), "packages/bus/fixtures/contract/ exists");
  const types = eventTypes();
  assert.ok(types.includes("service.heartbeat"), "the first Rust codec set: service.heartbeat");
  const required = (p: string, f: any, valid: boolean) => {
    assert.equal(typeof f.valid, "boolean", `${p}: valid`);
    assert.ok("payload" in f, `${p}: payload`);
    assert.equal("parsed" in f, valid && f.valid, `${p}: parsed present exactly on valid cases`);
  };
  for (const t of types) {
    const cases = files(join("events", t));
    assert.ok(cases.length > 0, `${t} has cases`);
    for (const c of cases) required(c, json(c), true);
  }
  const regs = files("registration");
  assert.ok(regs.length > 0);
  for (const c of regs) required(c, json(c), true);
  assert.ok(regs.some((c) => !json(c).valid), "registration poison cases");
  const frames = files("frames");
  assert.ok(frames.length > 0);
  for (const c of frames) {
    const f = json(c);
    assert.ok(Array.isArray(f.fields) && f.fields.every((p: unknown) => Array.isArray(p) && p.length === 2), `${c}: fields are [name, value] pairs`);
    assert.equal(typeof f.expected?.ok, "boolean", `${c}: expected.ok`);
  }
  assert.ok(frames.some((c) => json(c).expected.ok === false), "frame poison cases");
  const tags = files("tags");
  assert.ok(tags.length > 0);
  for (const c of tags) {
    const f = json(c);
    assert.equal(typeof f.tag, "string", `${c}: tag`);
    assert.equal(typeof f.valid, "boolean", `${c}: valid`);
  }
  assert.ok(tags.some((c) => json(c).valid) && tags.some((c) => !json(c).valid), "valid and invalid tags");
  for (const r of ["http", "dir", "dashboard", "mouth", "dryrun", "file"]) assert.ok(tags.some((c) => json(c).tag === r && !json(c).valid), `reserved tag ${r}`);
  assert.ok(tags.some((c) => json(c).tag.length === 32 && json(c).valid) && tags.some((c) => json(c).tag.length === 33 && !json(c).valid), "length edges");
  const k = json(join(root, "constants.json"));
  for (const name of ["FRAME_VERSION", "MAX_FRAME_BYTES", "AUDIO_MAXLEN", "AUDIO_STREAM_TTL_MS", "LEASE_INTERVALS", "REGISTRATION_VERSION", "DEFAULT_CONNECTOR_INTERVAL_MS"]) assert.ok(name in k, `constants.json: ${name}`);
  for (const name of ["prefix", "dir", "tag", "id", "audioStream", "connectorKey"]) assert.equal(typeof k.names?.[name], "string", `constants.json: names.${name}`);
});

// @spec BUS-NAT-FIX-002
test("every event and registration fixture: zod safeParse succeeds exactly for valid cases and the parse equals `parsed`", () => {
  let n = 0;
  for (const t of eventTypes()) {
    assert.ok(t in EventPayloads, `${t} is a registered event type`);
    for (const c of files(join("events", t))) {
      const f = json(c);
      const r = EventPayloads[t as keyof typeof EventPayloads].safeParse(f.payload);
      assert.equal(r.success, f.valid, c);
      if (f.valid) assert.deepEqual(r.success && r.data, f.parsed, c);
      n++;
    }
  }
  for (const c of files("registration")) {
    const f = json(c);
    const r = parseRegistration(JSON.stringify(f.payload));
    assert.equal(r !== undefined, f.valid, c);
    if (f.valid) assert.deepEqual(r, f.parsed, c);
    n++;
  }
  assert.ok(n >= 20, `checked ${n} cases`);
});

// @spec BUS-NAT-FIX-002
test("every tag fixture: the TypeScript tagProblem returns null exactly for valid cases", () => {
  const cases = files("tags");
  assert.ok(cases.length > 0);
  for (const c of cases) {
    const f = json(c);
    assert.equal(tagProblem(f.tag) === null, f.valid, c);
  }
});

// @spec BUS-NAT-FIX-002
test("constants.json equals the constants @cohost/bus exports and the names Bus.audioStream and Bus.connectorKey return", async () => {
  const k = json(join(root, "constants.json"));
  assert.equal(FRAME_VERSION, k.FRAME_VERSION);
  assert.equal(MAX_FRAME_BYTES, k.MAX_FRAME_BYTES);
  assert.deepEqual(AUDIO_MAXLEN, k.AUDIO_MAXLEN);
  assert.equal(AUDIO_STREAM_TTL_MS, k.AUDIO_STREAM_TTL_MS);
  assert.equal(LEASE_INTERVALS, k.LEASE_INTERVALS);
  assert.equal(REGISTRATION_VERSION, k.REGISTRATION_VERSION);
  assert.equal(DEFAULT_CONNECTOR_INTERVAL_MS, k.DEFAULT_CONNECTOR_INTERVAL_MS);
  const bus = new Bus("t", undefined, "redis://127.0.0.1:1", { transport: new FakeTransport().factory, frames: new FakeFrameTransport().factory, streamPrefix: k.names.prefix });
  try {
    assert.equal(bus.audioStream(k.names.dir, k.names.tag), k.names.audioStream);
    assert.equal(bus.connectorKey(k.names.id), k.names.connectorKey);
  } finally { await bus.stop(); }
});

// @spec BUS-NAT-FIX-003
test("every frame fixture decodes through the TypeScript decodeFrame to the fixture's DecodedFrame", () => {
  const cases = files("frames");
  assert.ok(cases.length > 0);
  for (const c of cases) {
    const f = json(c);
    assert.deepEqual(decodeFrame(wireFields(f.fields)), expectedFrame(f.expected), c);
  }
});
