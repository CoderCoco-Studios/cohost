import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeBus, event, silentLog } from "@cohost/testing";
import { wavWrap } from "@cohost/shared";
import { createInjectHandler } from "../src/inject.js";
import { createEarsHandler } from "../src/session.js";

// @spec EARS-INJ-011
test("the ears loop returns from an inject.request while STT is still working, so the next one is read at once", async () => {
  const bus = new FakeBus();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const started: string[] = [];
  bus.takeUpload = async () => wavWrap(Buffer.alloc(32000), 16000, 1);
  const handle = createInjectHandler({
    bus, log: silentLog,
    transcribe: async () => { started.push("stt"); await gate; return "hello there"; },
  });
  const loop = createEarsHandler({ onInject: handle });
  const req = (id: string) => event("inject.request", { id, target: "ears", kind: "audio", uploadId: "0123456789abcdef0123456789abcdef", contentType: "audio/wav", remember: false });
  try {
    const t0 = performance.now();
    await loop(req("a1"));
    await loop(req("a2"));
    assert.ok(performance.now() - t0 < 1000, "both reads returned without waiting for STT");
    assert.equal(bus.published.length, 0, "nothing is answered until STT finishes");
  } finally {
    release();
    await handle.drain();
  }
  assert.deepEqual(bus.of("inject.result").map((r) => r.id), ["a1", "a2"]);
});
