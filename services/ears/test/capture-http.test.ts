import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { FakeBus, silentLog, testConfig, waitFor } from "@cohost/testing";
import { INJECT_QUEUE_LIMIT, wavWrap } from "@cohost/shared";
import { INJECT_READ_TIMEOUT_MS, INJECT_MAX_BYTES } from "../src/inject.js";
import { createHttpCapture, type HttpCapture } from "../src/capture-http.js";
import type { HearClip, HearOutcome } from "../src/capture.js";
import { Hearing, stubTranscriber } from "../src/hearing.js";

const wav = (ms: number) => wavWrap(Buffer.alloc((ms / 1000) * 32000), 16000, 1);

/** An http capture on a free port, wired to the real Hearing path with the stub transcriber, unless `hear` is given. */
async function rig(over: { hear?: HearClip; maxBytes?: number; queueLimit?: number; bodyTimeoutMs?: number; token?: string; accepts?: (tag: string) => boolean } = {}) {
  const bus = new FakeBus();
  const hearing = new Hearing({ cfg: testConfig().ears, bus, log: silentLog, transcribe: stubTranscriber() });
  const cap = createHttpCapture({ host: "127.0.0.1", port: 0, log: silentLog, hear: over.hear ?? ((c, s, src, id) => hearing.heardClip(c, s, src, id)), ...over });
  await cap.start();
  const url = (q = "") => `http://127.0.0.1:${cap.port}/audio${q}`;
  return { bus, cap, url };
}

const post = (url: string, body: Buffer, type = "audio/wav") => fetch(url, { method: "POST", body, headers: { "content-type": type } });

// @spec EARS-CAP-005, EARS-CAP-007
test("POST /audio with a WAV runs the stub transcriber and publishes speech.heard; the reply says what was heard", async () => {
  const r = await rig();
  try {
    assert.equal(r.cap.status(), "ok");
    const res = await post(r.url(), wav(1000));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { heard: true, text: "stub transcript (1000 ms)" });
    const named = await post(r.url("?speaker=bob"), wav(500));
    assert.equal(named.status, 200);
    assert.deepEqual(r.bus.published.map((p) => (p.data as { speaker: string }).speaker), ["http", "bob"]);
    assert.equal((r.bus.published[0]!.data as { injected?: boolean }).injected, undefined);
  } finally {
    await r.cap.stop();
  }
});

// @spec EARS-CAP-005
test("raw 16-bit PCM is accepted; a clip that publishes nothing still answers 200 with the reason", async () => {
  const r = await rig();
  try {
    const raw = await post(r.url(), Buffer.alloc(32000), "audio/L16; rate=16000; channels=1");
    assert.equal(raw.status, 200);
    assert.equal(((await raw.json()) as HearOutcome).heard, true);
    const tooShort = await post(r.url(), wav(50));
    assert.deepEqual(await tooShort.json(), { heard: false, reason: "too-short" });
  } finally {
    await r.cap.stop();
  }
});

// @spec EARS-CAP-005
test("status codes: 404 path, 405 method, 415 type, 400 undecodable audio, 502 STT failure", async () => {
  const r = await rig({ hear: async (_c, s) => (s === "broken" ? { heard: false, reason: "stt-error" } : { heard: true, text: "ok" }) });
  try {
    assert.equal((await post(`http://127.0.0.1:${r.cap.port}/other`, wav(500))).status, 404);
    assert.equal((await fetch(r.url())).status, 405);
    assert.equal((await post(r.url(), wav(500), "text/plain")).status, 415);
    assert.equal((await post(r.url(), Buffer.from("garbage"), "audio/wav")).status, 400);
    assert.equal((await post(r.url("?speaker=broken"), wav(500))).status, 502);
    assert.equal((await post(r.url(), wav(500))).status, 200);
  } finally {
    await r.cap.stop();
  }
});

// @spec EARS-CAP-006
test("the byte cap is the shared inject cap; an oversize body is refused 413 by content-length and while streaming", async () => {
  assert.equal(INJECT_MAX_BYTES, 26_214_400);
  let heard = 0;
  const r = await rig({ maxBytes: 1000, hear: async () => { heard++; return { heard: true, text: "x" }; } });
  try {
    assert.equal((await post(r.url(), Buffer.alloc(2000))).status, 413);
    // No content-length: chunked body that crosses the cap while streaming.
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(r.url(), { method: "POST", headers: { "content-type": "audio/L16" } }, (res) => { res.resume(); resolve(res.statusCode!); });
      req.on("error", (e) => (e as NodeJS.ErrnoException).code === "ECONNRESET" || (e as NodeJS.ErrnoException).code === "EPIPE" ? undefined : reject(e));
      req.write(Buffer.alloc(600));
      req.write(Buffer.alloc(600));
      req.end();
    });
    assert.equal(status, 413);
    assert.equal(heard, 0);
  } finally {
    await r.cap.stop();
  }
});

// @spec EARS-CAP-006
test("a body that does not arrive within the body timeout is cut off with 408", async () => {
  assert.equal(INJECT_READ_TIMEOUT_MS, 30_000);
  const r = await rig({ bodyTimeoutMs: 80 });
  try {
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(r.url(), { method: "POST", headers: { "content-type": "audio/L16" } }, (res) => { res.resume(); resolve(res.statusCode!); });
      req.on("error", reject);
      req.write(Buffer.alloc(100));
      // never ends
    });
    assert.equal(status, 408);
  } finally {
    await r.cap.stop();
  }
});

// @spec EARS-CAP-006
test("clips are processed one at a time and a request beyond the queue limit is refused 503", async () => {
  assert.equal(INJECT_QUEUE_LIMIT, 8);
  let active = 0;
  let maxActive = 0;
  const waiters: (() => void)[] = [];
  const hear: HearClip = async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise<void>((resolve) => waiters.push(resolve));
    active--;
    return { heard: true, text: "ok" };
  };
  const r = await rig({ hear, queueLimit: 2 });
  try {
    const accepted = [1, 2, 3].map(() => post(r.url(), wav(500)));
    await waitFor(() => waiters.length === 1, "first clip in STT");
    await new Promise((resolve) => setTimeout(resolve, 50)); // let the other two arrive and queue
    assert.equal((await post(r.url(), wav(500))).status, 503, "one running + 2 waiting is full");
    while (accepted.length) {
      await waitFor(() => waiters.length > 0, "a clip waiting for STT");
      waiters.shift()!();
      assert.equal((await accepted.shift()!).status, 200);
    }
    assert.equal(maxActive, 1);
  } finally {
    waiters.forEach((w) => w());
    await r.cap.stop();
  }
});

// @spec EARS-CAP-007
test("a port that cannot be bound rejects start and reports down", async () => {
  const first = await rig();
  try {
    const second: HttpCapture = createHttpCapture({ host: "127.0.0.1", port: first.cap.port, log: silentLog, hear: async () => ({ heard: true, text: "x" }) });
    await assert.rejects(second.start(), /EADDRINUSE/);
    assert.equal(second.status(), "down");
    await second.stop();
  } finally {
    await first.cap.stop();
  }
});

// @spec EARS-CAP-012
test("stop closes the listener and waits for the clip in flight", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered = false;
  const r = await rig({ hear: async () => { entered = true; await gate; return { heard: true, text: "done" }; } });
  const port = r.cap.port;
  const inflight = post(r.url(), wav(500));
  try {
    await waitFor(() => entered, "clip in STT");
    let stopped = false;
    const stopping = r.cap.stop().then(() => { stopped = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(stopped, false, "stop waits for the clip");
    release();
    assert.equal((await inflight).status, 200);
    await stopping;
    assert.equal(r.cap.status(), "down");
    await assert.rejects(fetch(`http://127.0.0.1:${port}/audio`, { method: "POST", body: "x" }));
  } finally {
    release();
    await r.cap.stop();
  }
});

// @spec EARS-SRC-006, EARS-SRC-010
test("POST /audio?source=<tag>: the clip carries the tag as its source and, without speaker, as its speaker; no source means http", async () => {
  const r = await rig({ accepts: (t) => t === "desktop" });
  try {
    assert.equal((await post(r.url(), wav(500))).status, 200);
    assert.equal((await post(r.url("?source=desktop"), wav(500))).status, 200);
    assert.equal((await post(r.url("?source=desktop&speaker=Chris"), wav(500))).status, 200);
    assert.equal((await post(r.url("?source=http"), wav(500))).status, 200);
    assert.deepEqual(
      r.bus.published.map((p) => { const d = p.data as { speaker: string; source?: string }; return [d.speaker, d.source]; }),
      [["http", "http"], ["desktop", "desktop"], ["Chris", "desktop"], ["http", "http"]],
    );
  } finally {
    await r.cap.stop();
  }
});

// @spec EARS-SRC-010
test("an unknown or mistyped source tag is refused 400 and nothing is heard", async () => {
  const r = await rig({ accepts: (t) => t === "desktop" });
  try {
    for (const q of ["?source=desktp", "?source=dir", "?source=Desktop", "?source="]) {
      assert.equal((await post(r.url(q), wav(500))).status, 400, q);
    }
    assert.equal(r.bus.published.length, 0);
  } finally {
    await r.cap.stop();
  }
});

// @spec EARS-SRC-013
test("with a token set, POST /audio needs a matching Bearer header (401 otherwise); with none set no header is needed", async () => {
  const r = await rig({ token: "s3cret" });
  try {
    const send = (headers: Record<string, string>) => fetch(r.url(), { method: "POST", body: wav(500), headers: { "content-type": "audio/wav", ...headers } });
    assert.equal((await send({})).status, 401);
    assert.equal((await send({ authorization: "Bearer wrong" })).status, 401);
    assert.equal((await send({ authorization: "Basic s3cret" })).status, 401);
    assert.equal((await send({ authorization: "Bearer s3cret" })).status, 200);
    assert.equal(r.bus.published.length, 1);
  } finally {
    await r.cap.stop();
  }
  const open = await rig({ token: "" });
  try {
    assert.equal((await post(open.url(), wav(500))).status, 200);
  } finally {
    await open.cap.stop();
  }
});
