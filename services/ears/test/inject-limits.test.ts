import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeBus, event, silentLog } from "@cohost/testing";
import { INJECT_FETCH_TIMEOUT_MS, INJECT_MAX_BYTES, createInjectHandler } from "../src/inject.js";

const DASH = "http://dashboard:3000";
const req = (kind: string) => event("inject.request", { id: "a1", target: "ears", kind: kind as never, url: `${DASH}/uploads/abc`, text: "hi", remember: false });

function handler(fetchImpl: typeof fetch) {
  const bus = new FakeBus();
  let transcribed = 0;
  const handle = createInjectHandler({ bus, log: silentLog, dashboardUrl: DASH, fetch: fetchImpl, transcribe: async () => { transcribed++; return "hello"; } });
  return { bus, handle, transcribed: () => transcribed };
}

// @spec EARS-INJ-010
test("the shared inject handler is configured with the 25 MiB audio cap and a 30 s fetch timeout", () => {
  assert.equal(INJECT_MAX_BYTES, 26_214_400);
  assert.equal(INJECT_FETCH_TIMEOUT_MS, 30_000);
});

// @spec EARS-INJ-010
test("only kind audio is handled: image and text requests are refused without a fetch", async () => {
  let fetches = 0;
  const t = handler((async () => { fetches++; return new Response("x"); }) as never);
  for (const kind of ["image", "text"]) {
    t.handle(req(kind) as never);
    await t.handle.drain();
  }
  assert.equal(fetches, 0);
  assert.deepEqual(t.bus.of("inject.result").map((r) => [r.ok, r.detail]), [
    [false, "ears cannot handle kind 'image'"],
    [false, "ears cannot handle kind 'text'"],
  ]);
});

// @spec EARS-INJ-010
test("an upload over the byte cap is refused and never transcribed", async () => {
  const big = new Response(new Uint8Array(INJECT_MAX_BYTES + 1), { headers: { "content-type": "audio/wav" } });
  const t = handler((async () => big) as never);
  t.handle(req("audio") as never);
  await t.handle.drain();
  const [res] = t.bus.of("inject.result");
  assert.equal(res!.ok, false);
  assert.match(res!.detail ?? "", /larger than the 26214400 byte limit/);
  assert.equal(t.transcribed(), 0);
});

// @spec EARS-INJ-010
test("a non-2xx upload fetch is refused with its status", async () => {
  const t = handler((async () => new Response("no", { status: 404 })) as never);
  t.handle(req("audio") as never);
  await t.handle.drain();
  assert.equal(t.bus.of("inject.result")[0]!.detail, "fetch upload 404");
});
