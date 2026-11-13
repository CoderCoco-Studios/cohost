import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { FakeBus, event, recordingLog } from "@cohost/testing";
import { wavWrap } from "@cohost/shared";
import { Voice } from "../src/voice.js";

// voice.stop on the voice region (VOICE-STOP-*): queued, in-synthesis, claim-window and virtual-playing lines.

const say = (id: string, text = "hello chat") => event("brain.say", { id, text, emotion: "happy", gesture: "wave" });
const stop = (ids?: string[]) => event("voice.stop" as never, { reason: "barge-in", ...(ids ? { ids } : {}) } as never);
const halfSecond = wavWrap(Buffer.alloc(12000 * 2), 24000, 1);

function setup(synth: (t: string) => Promise<Buffer> = async () => halfSecond) {
  const bus = new FakeBus();
  const rec = recordingLog();
  const voice = new Voice({ bus, log: rec.log, synth, publicUrl: "http://voice:8700" });
  return { voice, bus, rec };
}
const flush = () => new Promise((r) => setImmediate(r));
const deferred = () => { let release!: () => void; const gate = new Promise<void>((r) => { release = r; }); return { gate, release }; };
const httpStatus = (voice: Voice, id: string) => {
  let code = 0;
  voice.handle({ method: "GET", url: `/audio/${id}.wav` } as never, { writeHead: (c: number) => { code = c; }, end() {} } as never);
  return code;
};
async function sayAndWait(voice: Voice, id: string, text?: string) { await voice.onEvent(say(id, text)); await voice.whenIdle(); }

beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
afterEach(() => mock.timers.reset());

// @spec VOICE-STOP-002, VOICE-STOP-003
test("a voice.stop without ids removes every queued line before synthesis and publishes nothing for them", async () => {
  const synthesized: string[] = [];
  const g = deferred();
  const { voice, bus } = setup(async (t) => { synthesized.push(t); await g.gate; return halfSecond; });
  await voice.onEvent(say("a", "first"));
  await voice.onEvent(say("b", "second"));
  await voice.onEvent(say("c", "third"));
  await flush();
  assert.deepEqual(synthesized, ["first"], "a is in synthesis; b and c wait");
  await voice.onEvent(stop());
  g.release();
  await voice.whenIdle();
  assert.deepEqual(synthesized, ["first"], "b and c were never synthesized");
  assert.deepEqual(bus.published.filter((p) => (p.type as string) !== "voice.stop").map((p) => p.type), [], "nothing published for any of them");
});

// @spec VOICE-STOP-002, VOICE-STOP-003
test("a voice.stop with ids removes only the listed queued lines", async () => {
  const synthesized: string[] = [];
  const g = deferred();
  const { voice, bus } = setup(async (t) => { synthesized.push(t); if (t === "first") await g.gate; return halfSecond; });
  await voice.onEvent(say("a", "first"));
  await voice.onEvent(say("b", "second"));
  await voice.onEvent(say("c", "third"));
  await flush();
  await voice.onEvent(stop(["b"]));
  g.release();
  await voice.whenIdle();
  assert.deepEqual(synthesized, ["first", "third"]);
  assert.deepEqual(bus.of("voice.utterance").map((u) => u.id), ["a", "c"]);
});

// @spec VOICE-STOP-004
test("a voice.stop for a line whose synthesis is running discards the result: no WAV stored, no utterance, no done, no timer", async () => {
  const g = deferred();
  const { voice, bus } = setup(async () => { await g.gate; return halfSecond; });
  await voice.onEvent(say("a"));
  await flush();
  await voice.onEvent(stop());
  g.release();
  await voice.whenIdle();
  assert.deepEqual(bus.of("voice.utterance"), []);
  assert.equal(httpStatus(voice, "a"), 404, "no WAV stored");
  mock.timers.tick(60_000);
  await flush();
  assert.deepEqual(bus.published.map((p) => p.type).filter((t) => (t as string) !== "voice.stop"), [], "no playing, no done");
});

// @spec VOICE-STOP-004
test("a voice.stop naming other ids leaves the line in synthesis alone", async () => {
  const g = deferred();
  const { voice, bus } = setup(async () => { await g.gate; return halfSecond; });
  await voice.onEvent(say("a"));
  await flush();
  await voice.onEvent(stop(["zzz"]));
  g.release();
  await voice.whenIdle();
  assert.deepEqual(bus.of("voice.utterance").map((u) => u.id), ["a"]);
});

// @spec VOICE-STOP-005
test("a voice.stop inside the claim window clears its timer: no virtual playing or done ever", async () => {
  const { voice, bus } = setup();
  await sayAndWait(voice, "u1");
  await voice.onEvent(stop(["u1"]));
  mock.timers.tick(60_000);
  await flush();
  assert.deepEqual(bus.of("voice.playing"), []);
  assert.deepEqual(bus.of("voice.done"), []);
});

// @spec VOICE-STOP-006
test("a voice.stop after the virtual playing clears the done timer and publishes voice.done interrupted, with no spoken text", async () => {
  const { voice, bus } = setup();
  await sayAndWait(voice, "u1");
  mock.timers.tick(1500);
  await flush();
  assert.deepEqual(bus.of("voice.playing"), [{ id: "u1", sink: "virtual" }]);
  await voice.onEvent(stop());
  await flush();
  assert.deepEqual(bus.of("voice.done"), [{ id: "u1", sink: "virtual", interrupted: true }]);
  mock.timers.tick(60_000);
  await flush();
  assert.equal(bus.of("voice.done").length, 1, "the cleared timer publishes no second done");
});

// @spec VOICE-STOP-007
test("a voice.stop naming no held line, or a line a real sink claimed, publishes nothing and changes nothing", async () => {
  const { voice, bus } = setup();
  await sayAndWait(voice, "u1");
  await voice.onEvent(event("voice.playing", { id: "u1", sink: "discord" })); // claimed by a real sink
  await voice.onEvent(stop(["u1"]));
  await voice.onEvent(stop(["nope"]));
  await voice.onEvent(stop());
  mock.timers.tick(60_000);
  await flush();
  assert.deepEqual(bus.published.map((p) => p.type), ["voice.utterance"]);
  assert.equal(httpStatus(voice, "u1"), 200, "stored audio kept");
  assert.equal(voice.claimCount, 1, "the claim stands");
  // Everything finished: a stop on an empty voice is also silent.
  const idle = setup();
  await idle.voice.onEvent(stop());
  assert.deepEqual(idle.bus.published, []);
});

// @spec VOICE-STOP-007
test("a voice.stop after the virtual done was published changes nothing", async () => {
  const { voice, bus } = setup();
  await sayAndWait(voice, "u1");
  mock.timers.tick(1500);
  await flush();
  mock.timers.tick(500);
  await flush();
  assert.equal(bus.of("voice.done").length, 1);
  await voice.onEvent(stop());
  await flush();
  assert.equal(bus.of("voice.done").length, 1, "no interrupted done for a finished line");
});

// @spec VOICE-STOP-008
test("every brain.say read after a voice.stop is synthesized as usual", async () => {
  const { voice, bus } = setup();
  await voice.onEvent(stop());
  await sayAndWait(voice, "later");
  assert.deepEqual(bus.of("voice.utterance").map((u) => u.id), ["later"]);
  mock.timers.tick(1500);
  await flush();
  assert.deepEqual(bus.of("voice.playing"), [{ id: "later", sink: "virtual" }]);
});

// @spec VOICE-STOP-001
test("the voice.stop is handled in stream order with brain.say: a say read after it is spoken, one read before it is dropped", async () => {
  const g = deferred();
  let n = 0;
  const { voice, bus } = setup(async () => { if (++n === 1) await g.gate; return halfSecond; });
  await voice.onEvent(say("a")); await voice.onEvent(say("b"));
  await flush();
  await voice.onEvent(stop());
  await voice.onEvent(say("c"));
  g.release();
  await voice.whenIdle();
  assert.deepEqual(bus.of("voice.utterance").map((u) => u.id), ["c"]);
});
