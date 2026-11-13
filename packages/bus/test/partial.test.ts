import { test } from "node:test";
import assert from "node:assert/strict";
import * as bus from "../src/index.js";
import { EventPayloads, type BusEvent } from "../src/index.js";

const base = { speaker: "Chris", source: "discord", text: "hello there", utteranceId: "u-1", seq: 0 };
// The schema is read through the catalogue so a missing event type is a failed assertion, not an import error.
const partial = () => {
  const schema = (EventPayloads as Record<string, { safeParse(v: unknown): { success: boolean } } | undefined>)["speech.partial"];
  assert.ok(schema, "EventPayloads has speech.partial");
  return schema;
};

// @spec BUS-EVT-026
test("speech.partial requires string speaker, source, text and utteranceId and a non-negative integer seq", () => {
  const s = partial();
  assert.equal(s.safeParse(base).success, true);
  for (const k of ["speaker", "source", "text", "utteranceId", "seq"] as const) {
    const { [k]: _omit, ...rest } = base;
    assert.equal(s.safeParse(rest).success, false, `rejects a payload without ${k}`);
  }
  for (const k of ["speaker", "source", "text", "utteranceId"] as const) {
    assert.equal(s.safeParse({ ...base, [k]: 5 }).success, false, `${k} must be a string`);
  }
  assert.equal(s.safeParse({ ...base, seq: 0 }).success, true);
  assert.equal(s.safeParse({ ...base, seq: 7 }).success, true);
  for (const bad of [-1, 1.5, Number.NaN, "1", null]) assert.equal(s.safeParse({ ...base, seq: bad }).success, false, `seq=${String(bad)}`);
});

// @spec BUS-EVT-026
test("speech.partial accepts an optional string speakerId and an optional timing, and rejects a bad timing", () => {
  const s = partial();
  assert.equal(s.safeParse({ ...base, speakerId: "u9" }).success, true);
  assert.equal(s.safeParse({ ...base, speakerId: 9 }).success, false);
  assert.equal(s.safeParse({ ...base, timing: { audioEndedAt: 1_700_000_000_000 } }).success, true);
  assert.equal(s.safeParse({ ...base, timing: {} }).success, true);
  assert.equal(s.safeParse({ ...base, timing: { audioEndedAt: -1 } }).success, false);
});

// @spec BUS-EVT-027
test("speech.heard accepts an optional string utteranceId and stays valid without it", () => {
  const s = EventPayloads["speech.heard"];
  const heard = { speaker: "Chris", text: "hi", durationMs: 100 };
  assert.equal(s.safeParse(heard).success, true, "an event written before the field existed, or a dashboard injection");
  assert.equal(s.safeParse({ ...heard, utteranceId: "u-1" }).success, true);
  assert.equal((s.parse({ ...heard, utteranceId: "u-1" }) as { utteranceId?: string }).utteranceId, "u-1", "the id survives validation");
  assert.equal(s.safeParse({ ...heard, utteranceId: 5 }).success, false);
});

const partialEv = (data: Partial<typeof base> = {}, ts = 1_000_000): BusEvent<"speech.partial"> =>
  ({ id: `${ts}-0`, type: "speech.partial", ts, source: "ears", data: { ...base, ...data } }) as unknown as BusEvent<"speech.partial">;
const heardEv = (data: Record<string, unknown>, ts = 1_000_100): BusEvent<"speech.heard"> =>
  ({ id: `${ts}-1`, type: "speech.heard", ts, source: "ears", data: { speaker: "Chris", source: "discord", text: "x", durationMs: 1, ...data } }) as unknown as BusEvent<"speech.heard">;

// The signature the tests assume (the spec names no function): isPartialStale(partial, laterEvents, now) => boolean.
const stale = (p: BusEvent<"speech.partial">, later: BusEvent[], now: number): boolean => {
  const fn = (bus as unknown as { isPartialStale?: (p: unknown, later: unknown[], now: number) => boolean }).isPartialStale;
  assert.equal(typeof fn, "function", "@cohost/bus exports isPartialStale");
  return fn!(p, later, now);
};

// @spec BUS-EVT-028
test("PARTIAL_STALE_MS is 5000 and a partial is stale once that long has passed since its envelope ts", () => {
  assert.equal((bus as unknown as { PARTIAL_STALE_MS?: number }).PARTIAL_STALE_MS, 5000);
  const p = partialEv();
  assert.equal(stale(p, [], p.ts), false);
  assert.equal(stale(p, [], p.ts + 4999), false);
  assert.equal(stale(p, [], p.ts + 5000), true);
  assert.equal(stale(p, [], p.ts + 60_000), true);
});

// @spec BUS-EVT-028
test("a partial is stale once its own speech.heard, or a different utterance of the same speaker and source, is seen", () => {
  const p = partialEv();
  const now = p.ts + 100;
  assert.equal(stale(p, [heardEv({ utteranceId: "u-1" })], now), true, "its own final");
  assert.equal(stale(p, [partialEv({ utteranceId: "u-2" }, p.ts + 50)], now), true, "a later utterance's partial, same speaker and source");
  assert.equal(stale(p, [heardEv({ utteranceId: "u-2" })], now), true, "a later utterance's final, same speaker and source");
});

// @spec BUS-EVT-028
test("a later partial of the same utterance, or events of another speaker or source, do not make it stale", () => {
  const p = partialEv();
  const now = p.ts + 100;
  assert.equal(stale(p, [partialEv({ seq: 1, text: "hello there my" }, p.ts + 50)], now), false, "same utteranceId, next seq");
  assert.equal(stale(p, [heardEv({ utteranceId: "u-9", speaker: "Bob" })], now), false, "another speaker");
  assert.equal(stale(p, [heardEv({ utteranceId: "u-9", source: "desktop" })], now), false, "another source");
  assert.equal(stale(p, [partialEv({ utteranceId: "u-9", source: "desktop" }, p.ts + 50)], now), false, "another source's partial");
});

// @spec BUS-EVT-029
test("a speech.heard with no utteranceId stales no partial; only PARTIAL_STALE_MS or the next utterance of the same speaker and source does", () => {
  const p = partialEv();
  assert.equal(stale(p, [heardEv({})], p.ts + 100), false);
  assert.equal(stale(p, [heardEv({}), heardEv({ utteranceId: "u-2" })], p.ts + 100), true, "the next identified utterance still does");
  assert.equal(stale(p, [heardEv({})], p.ts + 5000), true, "and time still does");
});
