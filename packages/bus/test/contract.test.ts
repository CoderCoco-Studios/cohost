// Shared contract fixtures: the TS codecs and the Rust codec (crates/cohost-bus/tests/contract.rs) read the same files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { EventPayloads, parseRegistration } from "../src/index.js";
import * as native from "../src/native.js";

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
test("the fixture directory holds events/<type>/<case>.json, registration/<case>.json and frames/<case>.json of the specified shapes", () => {
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

// @spec BUS-NAT-FIX-003
test("every frame fixture decodes through the native decodeFrame to the fixture's DecodedFrame", () => {
  const cases = files("frames");
  assert.ok(cases.length > 0);
  for (const c of cases) {
    const f = json(c);
    assert.deepEqual(native.decodeFrame(wireFields(f.fields)), expectedFrame(f.expected), c);
  }
});
