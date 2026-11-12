import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeBus, event, silentLog } from "@cohost/testing";
import { INJECT_READ_TIMEOUT_MS, INJECT_MAX_BYTES, createInjectHandler } from "../src/inject.js";

const req = (kind: string) => event("inject.request", { id: "a1", target: "ears", kind: kind as never, uploadId: "0123456789abcdef0123456789abcdef", contentType: "audio/wav", text: "hi", remember: false });

function handler(take: () => Promise<Buffer | null>) {
  const bus = new FakeBus();
  bus.takeUpload = take;
  let transcribed = 0;
  const handle = createInjectHandler({ bus, log: silentLog, transcribe: async () => { transcribed++; return "hello"; } });
  return { bus, handle, transcribed: () => transcribed };
}

// @spec EARS-INJ-010
test("the shared inject handler is configured with the 25 MiB audio cap and a 30 s upload read timeout", () => {
  assert.equal(INJECT_MAX_BYTES, 26_214_400);
  assert.equal(INJECT_READ_TIMEOUT_MS, 30_000);
});

// @spec EARS-INJ-010
test("only kind audio is handled: image and text requests are refused without reading an upload", async () => {
  let reads = 0;
  const t = handler(async () => { reads++; return Buffer.from("x"); });
  for (const kind of ["image", "text"]) {
    t.handle(req(kind) as never);
    await t.handle.drain();
  }
  assert.equal(reads, 0);
  assert.deepEqual(t.bus.of("inject.result").map((r) => [r.ok, r.detail]), [
    [false, "ears cannot handle kind 'image'"],
    [false, "ears cannot handle kind 'text'"],
  ]);
});

// @spec EARS-INJ-010
test("an upload over the byte cap is refused and never transcribed", async () => {
  const t = handler(async () => Buffer.alloc(INJECT_MAX_BYTES + 1));
  t.handle(req("audio") as never);
  await t.handle.drain();
  const [res] = t.bus.of("inject.result");
  assert.equal(res!.ok, false);
  assert.match(res!.detail ?? "", /larger than the 26214400 byte limit/);
  assert.equal(t.transcribed(), 0);
});

// @spec EARS-INJ-010
test("a missing upload is refused with `upload expired or missing`", async () => {
  const t = handler(async () => null);
  t.handle(req("audio") as never);
  await t.handle.drain();
  assert.equal(t.bus.of("inject.result")[0]!.detail, "upload expired or missing");
});
