import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeBus, event, recordingLog, silentLog, testConfig } from "@cohost/testing";
import { wavWrap } from "@cohost/shared";
import { Hearing } from "../src/hearing.js";
import { createInjectHandler } from "../src/inject.js";

const pcmMs = (ms: number) => Buffer.alloc(Math.round((ms / 1000) * 48000) * 4);

function hearingWith(ears: Record<string, unknown>, reply: string) {
  const bus = new FakeBus();
  const rec = recordingLog();
  const h = new Hearing({ cfg: testConfig({ ears }).ears, bus, log: rec.log, transcribe: async () => reply });
  return { h, bus, rec };
}

// @spec EARS-HEAR-006, EARS-HEAR-007
test("hearing: a transcript of non-ASCII letters is published, not dropped as non-word", async () => {
  const { h, bus } = hearingWith({}, "こんにちは");
  await h.heard(pcmMs(500), "Chris", "u1");
  assert.equal(bus.of("speech.heard")[0]!.text, "こんにちは");
});

// @spec EARS-HEAR-010
test("hearing: a transcript equal to an ears.drop_phrases entry publishes nothing; other text still does", async () => {
  const a = hearingWith({ drop_phrases: ["Thank you.", "Thanks for watching!"] }, " thank YOU ");
  await a.h.heard(pcmMs(500), "Chris", "u1");
  assert.equal(a.bus.published.length, 0);
  assert.ok(a.rec.lines.some((l) => l.level === "debug"));
  const b = hearingWith({ drop_phrases: ["Thank you."] }, "thank you for the help");
  await b.h.heard(pcmMs(500), "Chris", "u1");
  assert.equal(b.bus.of("speech.heard").length, 1);
  const c = hearingWith({}, "Thank you.");
  await c.h.heard(pcmMs(500), "Chris", "u1");
  assert.equal(c.bus.of("speech.heard").length, 1, "the default list is empty");
});

// @spec EARS-HEAR-010
test("config: ears.drop_phrases defaults to an empty list", () => {
  assert.deepEqual(testConfig().ears.drop_phrases, []);
  assert.deepEqual(testConfig({ ears: { drop_phrases: ["a"] } }).ears.drop_phrases, ["a"]);
});

// @spec EARS-STUB-001, EARS-STUB-002
test("config: ears.stt_engine is blank-to-speaches and accepts stub", () => {
  assert.equal(testConfig().ears.stt_engine, "speaches");
  assert.equal(testConfig({ ears: { stt_engine: "" } }).ears.stt_engine, "speaches");
  assert.equal(testConfig({ ears: { stt_engine: "stub" } }).ears.stt_engine, "stub");
  assert.throws(() => testConfig({ ears: { stt_engine: "bogus" } }));
});

// @spec EARS-INJ-006, EARS-INJ-008, EARS-HEAR-010
test("injected clips: non-ASCII transcripts are published, and drop phrases are not applied", async () => {
  for (const text of ["Привет", "Thank you."]) {
    const bus = new FakeBus();
    const handle = createInjectHandler({
      bus, log: silentLog, dashboardUrl: "http://dashboard:3000",
      fetch: async () => new Response(wavWrap(Buffer.alloc(32000), 16000, 1), { headers: { "content-type": "audio/wav" } }),
      transcribe: async () => text,
    });
    handle(event("inject.request", { id: "a1", target: "ears", kind: "audio", url: "http://dashboard:3000/uploads/abc", remember: false }) as never);
    await handle.drain();
    assert.equal(bus.of("speech.heard")[0]!.text, text);
    assert.equal(bus.of("inject.result")[0]!.ok, true);
  }
});
