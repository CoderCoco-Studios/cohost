import { test } from "node:test";
import assert from "node:assert/strict";
import { createKyutaiEngine } from "../src/kyutai.js";
import { SttCapacityError, type SttSession } from "../src/engines.js";
import { earsCfg, kyutaiServer, sleep, step, until, word, type KyutaiServer } from "./stt-servers.js";

// The `kyutai` adapter (EARS-KYU-*) against a fake moshi-server ASR stream on a real local socket. Test seam the code phase must
// provide: `createKyutaiEngine(cfg)` in src/kyutai.ts (see stt-servers.ts). Timers are real and short: ears.stt_timeout_ms is
// 300 ms; the 80 ms fill is observed in real time. The no-free-channel answer is the `Error` message "no free channels".
const TIMEOUT = 300;
const cfgFor = (srv: KyutaiServer, kyutai: Record<string, unknown> = {}, over: Record<string, unknown> = {}) =>
  earsCfg({ stt_engine: "kyutai", stt_timeout_ms: TIMEOUT, kyutai: { url: srv.url, ...kyutai }, ...over });
const open = (srv: KyutaiServer, kyutai: Record<string, unknown> = {}, over: Record<string, unknown> = {}): Promise<SttSession> =>
  createKyutaiEngine(cfgFor(srv, kyutai, over)).open({ signal: new AbortController().signal });

/** `ms` ms of 16 kHz s16le, every sample `v` (16384 is 0.5 as float32). */
const tone = (ms: number, v = 16384) => { const b = Buffer.alloc((ms / 1000) * 16000 * 2); for (let i = 0; i < b.length; i += 2) b.writeInt16LE(v, i); return b; };
const FILL = 1920; // 80 ms at 24 kHz
const SILENCE_06 = 14400; // 0.6 s at 24 kHz
const isZero = (a: ArrayLike<number>) => Array.from(a).every((x) => x === 0);
/** Total samples of the zero messages that arrived after the last non-zero message and before the first Marker. */
const zerosBeforeMarker = (srv: KyutaiServer): number => {
  let zeros = 0;
  for (const { msg } of srv.messages) {
    if (msg.type === "Marker") break;
    if (msg.type !== "Audio") continue;
    const pcm = (msg as { pcm: ArrayLike<number> }).pcm;
    zeros = isZero(pcm) ? zeros + pcm.length : 0;
  }
  return zeros;
};

// @spec EARS-KYU-001
test("connects to <url>/api/asr-streaming with the kyutai-api-key header, or public_token when the key is empty", async () => {
  const keyed = await kyutaiServer();
  const open_ = await kyutaiServer();
  try {
    const a = await open(keyed, { api_key: "k-123" });
    const b = await open(open_);
    assert.equal(keyed.upgrades[0]!.url, "/api/asr-streaming");
    assert.equal(keyed.upgrades[0]!.headers["kyutai-api-key"], "k-123");
    assert.equal(open_.upgrades[0]!.url, "/api/asr-streaming");
    assert.equal(open_.upgrades[0]!.headers["kyutai-api-key"], "public_token", "the upstream example's default token (#190)");
    a.abort(); b.abort();
  } finally { await keyed.close(); await open_.close(); }
});

// @spec EARS-KYU-001
test("open() waits for Ready, and no audio is sent before it", async () => {
  const srv = await kyutaiServer({ ready: 150 });
  try {
    let opened = false;
    const p = open(srv).then((s) => { opened = true; return s; });
    await until(() => srv.upgrades.length === 1, "the connection");
    await sleep(70);
    assert.equal(opened, false, "still waiting for Ready");
    assert.equal(srv.messages.length, 0, "nothing sent before Ready");
    const s = await p;
    assert.equal(opened, true);
    s.abort();
  } finally { await srv.close(); }
});

// @spec EARS-KYU-001
test("an Error answer to the connect (not no-free-channel) rejects open() as an outage", async () => {
  const srv = await kyutaiServer({ ready: false, errorInsteadOfReady: "model failed to load" });
  try {
    await assert.rejects(open(srv), (err: Error) => !(err instanceof SttCapacityError));
  } finally { await srv.close(); }
});

// @spec EARS-KYU-002
test("audio goes as MessagePack Audio messages of float32 samples in -1..1 at 24 kHz (16 kHz upsampled 3:2)", async () => {
  const srv = await kyutaiServer();
  try {
    const s = await open(srv);
    for (let i = 0; i < 5; i++) await s.push(tone(20)); // 100 ms = 1600 samples at 16 kHz
    await until(() => srv.samples().length >= 2400 - 4, "the upsampled audio");
    const samples = srv.samples();
    assert.ok(srv.messages.every((m) => m.msg.type === "Audio"), "only Audio messages");
    assert.ok(Math.abs(samples.length - 2400) <= 5, `100 ms is 2400 samples at 24 kHz, got ${samples.length}`);
    assert.ok(samples.every((x) => x >= -1 && x <= 1), "within -1..1");
    assert.ok(samples.every((x) => Math.abs(x - 0.5) < 1e-3), "a constant 0.5 stays 0.5 (int16 16384 / 32768)");
    s.abort();
  } finally { await srv.close(); }
});

// @spec EARS-KYU-002
test("negative and full-scale samples are scaled to float32 in -1..1", async () => {
  const srv = await kyutaiServer();
  try {
    const s = await open(srv);
    await s.push(tone(20, -32768));
    await until(() => srv.samples().length >= 400, "the audio");
    assert.ok(srv.samples().every((x) => x >= -1 && x <= 1 && Math.abs(x + 1) < 1e-3), "-32768 is -1.0");
    s.abort();
  } finally { await srv.close(); }
});

// @spec EARS-KYU-003
test("with no frame for 80 ms the session sends 80 ms of zeros, again every 80 ms, and none while frames keep arriving", async () => {
  const srv = await kyutaiServer();
  try {
    const s = await open(srv);
    // frames every 20 ms for 200 ms: no fill
    for (let i = 0; i < 10; i++) { await s.push(tone(20)); await sleep(20); }
    const fillsWhileFlowing = srv.messages.filter((m) => m.msg.type === "Audio" && isZero((m.msg as { pcm: ArrayLike<number> }).pcm)).length;
    assert.equal(fillsWhileFlowing, 0, "no fill while frames arrive within 80 ms of each other");
    const before = srv.audioSizes().length;
    await sleep(380);
    const after = srv.messages.slice(before).filter((m) => m.msg.type === "Audio");
    const fills = after.map((m) => (m.msg as { pcm: ArrayLike<number> }).pcm).filter(isZero);
    assert.ok(fills.length >= 3 && fills.length <= 5, `about one fill per 80 ms in 380 ms, got ${fills.length}`);
    assert.ok(fills.every((f) => f.length === FILL), `each fill is 80 ms (${FILL} samples)`);
    s.abort();
  } finally { await srv.close(); }
});

// @spec EARS-KYU-003
test("fill is not speech: it produces no hypothesis and no end of turn", async () => {
  const srv = await kyutaiServer();
  try {
    const s = await open(srv, { end_of_turn: "on" });
    const seen: string[] = []; let eot = 0;
    s.onHypothesis((t) => seen.push(t)); s.onEndOfTurn(() => eot++);
    await sleep(300);
    assert.ok(srv.audioSizes().length >= 2, "fill was sent");
    assert.deepEqual(seen, []);
    assert.equal(eot, 0);
    s.abort();
  } finally { await srv.close(); }
});

// @spec EARS-KYU-004
test("a frame that arrives after fill is appended to the stream, in order", async () => {
  const srv = await kyutaiServer();
  try {
    const s = await open(srv);
    await s.push(tone(40, 8192)); // 0.25
    await sleep(200); // fill
    await s.push(tone(40, 16384)); // 0.5
    await until(() => srv.samples().filter((x) => Math.abs(x - 0.5) < 1e-3).length >= 900, "the second frame");
    const samples = srv.samples();
    const firstReal = samples.findIndex((x) => x !== 0);
    const lastZero = samples.map((x) => x === 0).lastIndexOf(true);
    const secondReal = samples.findIndex((x) => Math.abs(x - 0.5) < 1e-3);
    assert.ok(Math.abs(samples[firstReal]! - 0.25) < 1e-3);
    assert.ok(firstReal < lastZero && lastZero < secondReal, "first frame, then fill, then the new frame");
    s.abort();
  } finally { await srv.close(); }
});

// @spec EARS-KYU-005
test("each Word is appended to the hypothesis once, joined by a single space; EndWord is ignored", async () => {
  const srv = await kyutaiServer();
  try {
    const s = await open(srv);
    const seen: string[] = [];
    s.onHypothesis((t) => seen.push(t));
    srv.send(word("hello"));
    srv.send({ type: "EndWord", stop_time: 0.4 });
    srv.send(word("there", 0.5));
    srv.send({ type: "EndWord", stop_time: 0.9 });
    srv.send(word("world", 1));
    await until(() => seen.length === 3, "three hypotheses");
    await sleep(40);
    assert.deepEqual(seen, ["hello", "hello there", "hello there world"], "one change per Word, none for EndWord");
    s.abort();
  } finally { await srv.close(); }
});

// @spec EARS-KYU-006
test("finish(): at least 0.6 s of silence after the last real audio, then a Marker, silence until it is echoed, and the hypothesis is the final", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const srv = await kyutaiServer({ echo: (s, id) => { void gate.then(() => s.send({ type: "Marker", id })); } });
  try {
    const s = await open(srv);
    await s.push(tone(100));
    srv.send(word("hello"));
    srv.send(word("world", 0.5));
    await sleep(20);
    const fin = s.finish();
    await until(() => srv.markers().length === 1, "the Marker");
    const zeros = zerosBeforeMarker(srv);
    assert.ok(zeros >= SILENCE_06 && zeros <= SILENCE_06 + FILL, `silence before the Marker covers 0.6 s (${zeros} samples)`);
    const at = srv.audioSizes().length;
    await sleep(200);
    const more = srv.messages.slice(srv.messages.findIndex((m) => m.msg.type === "Marker") + 1).filter((m) => m.msg.type === "Audio");
    assert.ok(more.length >= 1 && more.every((m) => isZero((m.msg as { pcm: ArrayLike<number> }).pcm)), "silence keeps flowing until the echo");
    assert.ok(srv.audioSizes().length > at);
    // a word that arrives before the echo is part of the final
    srv.send(word("again", 1));
    release();
    assert.equal(await fin, "hello world again");
  } finally { await srv.close(); }
});

// @spec EARS-KYU-006
test("finish(): silence already sent (fill) counts toward the 0.6 s; only the shortfall is added", async () => {
  const srv = await kyutaiServer();
  try {
    const s = await open(srv);
    await s.push(tone(100));
    await sleep(330); // about four fills, 0.32 s of silence
    const fin = s.finish();
    await until(() => srv.markers().length === 1, "the Marker");
    const zeros = zerosBeforeMarker(srv);
    assert.ok(zeros >= SILENCE_06, `at least 0.6 s of silence, got ${zeros}`);
    assert.ok(zeros <= SILENCE_06 + FILL, `no more than the shortfall plus one fill, got ${zeros}`);
    await fin;
  } finally { await srv.close(); }
});

// @spec EARS-KYU-006
test("finish() resolves with the words received, and the connection is closed afterwards", async () => {
  const srv = await kyutaiServer();
  try {
    const s = await open(srv);
    await s.push(tone(60));
    srv.send(word("one"));
    srv.send(word("two", 0.3));
    await sleep(20);
    assert.equal(await s.finish(), "one two");
    await until(() => srv.sockets[0]!.readyState === srv.sockets[0]!.CLOSED || srv.sockets[0]!.readyState === srv.sockets[0]!.CLOSING, "the connection closing");
  } finally { await srv.close(); }
});

// @spec EARS-KYU-007
test("a Marker never echoed: after ears.stt_timeout_ms finish() resolves with the words so far; the session did not fail", async () => {
  const srv = await kyutaiServer({ echo: false });
  try {
    const s = await open(srv);
    let failed = false;
    void s.failed.then(() => { failed = true; });
    await s.push(tone(60));
    srv.send(word("so"));
    srv.send(word("far", 0.3));
    await sleep(20);
    const t0 = Date.now();
    assert.equal(await s.finish(), "so far");
    const took = Date.now() - t0;
    assert.ok(took >= TIMEOUT - 30 && took < TIMEOUT * 3, `waited for the bound, ${took} ms`);
    await sleep(30);
    assert.equal(failed, false, "a flush timeout is not a failure");
    assert.equal(srv.sockets[0]!.readyState === srv.sockets[0]!.OPEN || srv.sockets[0]!.readyState === srv.sockets[0]!.CLOSING || srv.sockets[0]!.readyState === srv.sockets[0]!.CLOSED, true);
  } finally { await srv.close(); }
});

// @spec EARS-KYU-014
test("an Error message fails the session: failed settles with its message and finish() rejects", async () => {
  const srv = await kyutaiServer();
  try {
    const s = await open(srv);
    srv.send({ type: "Error", message: "decoder crashed" });
    const err = await Promise.race([s.failed, sleep(1000).then(() => undefined)]);
    assert.ok(err instanceof Error);
    assert.match(err.message, /decoder crashed/);
    assert.ok(!(err instanceof SttCapacityError));
    await assert.rejects(s.finish());
  } finally { await srv.close(); }
});

// @spec EARS-KYU-014
test("a connection that closes before the close of the utterance fails the session", async () => {
  const srv = await kyutaiServer();
  try {
    const s = await open(srv);
    srv.closeConnection();
    assert.ok((await Promise.race([s.failed, sleep(1000).then(() => undefined)])) instanceof Error);
  } finally { await srv.close(); }
});

// @spec EARS-KYU-014
test("a connection that closes during finish() (the Marker awaited) is a failure, not a timeout", async () => {
  const srv = await kyutaiServer({ echo: (s) => s.closeConnection() });
  try {
    const s = await open(srv);
    await s.push(tone(60));
    srv.send(word("lost"));
    const failed = s.failed;
    const t0 = Date.now();
    await assert.rejects(s.finish());
    assert.ok(Date.now() - t0 < TIMEOUT, "rejected on the close, not at the bound");
    assert.ok((await Promise.race([failed, sleep(1000).then(() => undefined)])) instanceof Error);
  } finally { await srv.close(); }
});

// @spec EARS-KYU-014, EARS-SES-009
test("the no-free-channel Error answer rejects open() with SttCapacityError", async () => {
  const srv = await kyutaiServer({ ready: false, errorInsteadOfReady: "no free channels" });
  try {
    await assert.rejects(open(srv), (err: unknown) => err instanceof SttCapacityError);
  } finally { await srv.close(); }
});

// --------------------------------------------------------------------------------------------------- end of turn

/** A session with `end_of_turn` on, counting its signals; one Word has arrived. */
async function eotSession(srv: KyutaiServer, kyutai: Record<string, unknown> = { end_of_turn: "on" }, over: Record<string, unknown> = {}) {
  const s = await open(srv, kyutai, over);
  const sig = { n: 0 };
  s.onEndOfTurn(() => sig.n++);
  return { s, sig };
}

// @spec EARS-KYU-008
test("end_of_turn on: the third probability above the threshold (default 0.5) signals an end of turn; the others do not", async () => {
  const srv = await kyutaiServer();
  try {
    const { s, sig } = await eotSession(srv);
    srv.send(word("hi"));
    srv.send(step([0.99, 0.99, 0.4, 0.99]));
    await sleep(60);
    assert.equal(sig.n, 0, "only the third probability counts, and 0.4 is below 0.5");
    srv.send(step([0, 0, 0.5, 0]));
    await sleep(60);
    assert.equal(sig.n, 0, "exactly the threshold does not exceed it");
    srv.send(step([0, 0, 0.51, 0]));
    await until(() => sig.n === 1, "the end of turn");
    s.abort();
  } finally { await srv.close(); }
});

// @spec EARS-KYU-008
test("end_of_turn_threshold sets the bar", async () => {
  const srv = await kyutaiServer();
  try {
    const { s, sig } = await eotSession(srv, { end_of_turn: "on", end_of_turn_threshold: 0.8 });
    srv.send(word("hi"));
    srv.send(step([0, 0, 0.7, 0]));
    await sleep(60);
    assert.equal(sig.n, 0);
    srv.send(step([0, 0, 0.9, 0]));
    await until(() => sig.n === 1, "the end of turn");
    s.abort();
  } finally { await srv.close(); }
});

// @spec EARS-KYU-009
test("no end of turn before a Word has arrived", async () => {
  const srv = await kyutaiServer();
  try {
    const { s, sig } = await eotSession(srv);
    srv.send(step([0, 0, 0.99, 0]));
    await sleep(60);
    assert.equal(sig.n, 0, "a high probability with no Word is ignored");
    srv.send(word("now"));
    srv.send(step([0, 0, 0.99, 0]));
    await until(() => sig.n === 1, "the end of turn after a Word");
    s.abort();
  } finally { await srv.close(); }
});

// @spec EARS-KYU-009
test("at most one end of turn per session", async () => {
  const srv = await kyutaiServer();
  try {
    const { s, sig } = await eotSession(srv);
    srv.send(word("hi"));
    for (let i = 0; i < 4; i++) srv.send(step([0, 0, 0.99, 0], i));
    await until(() => sig.n >= 1, "the end of turn");
    await sleep(80);
    assert.equal(sig.n, 1);
    s.abort();
  } finally { await srv.close(); }
});

// @spec EARS-KYU-009
test("no end of turn once the utterance is closed (finish() called)", async () => {
  const srv = await kyutaiServer({ echo: false });
  try {
    const { s, sig } = await eotSession(srv);
    srv.send(word("hi"));
    await sleep(20);
    const fin = s.finish();
    await until(() => srv.markers().length === 1, "the Marker");
    srv.send(step([0, 0, 0.99, 0]));
    await sleep(60);
    assert.equal(sig.n, 0);
    assert.equal(await fin, "hi");
  } finally { await srv.close(); }
});

// @spec EARS-KYU-009
test("under ears.vad.engine gap the session never signals an end of turn", async () => {
  const srv = await kyutaiServer();
  try {
    const { s, sig } = await eotSession(srv, { end_of_turn: "on" }, { vad: { engine: "gap" } });
    srv.send(word("hi"));
    srv.send(step([0, 0, 0.99, 0]));
    await sleep(100);
    assert.equal(sig.n, 0);
    s.abort();
  } finally { await srv.close(); }
});

// @spec EARS-KYU-013
test("end_of_turn off, and blank (which is off): the third probability of every Step is ignored", async () => {
  for (const kyutai of [{ end_of_turn: "off" }, { end_of_turn: "" }, {}]) {
    const srv = await kyutaiServer();
    try {
      const { s, sig } = await eotSession(srv, kyutai);
      srv.send(word("hi"));
      srv.send(step([0.99, 0.99, 0.99, 0.99]));
      await sleep(80);
      assert.equal(sig.n, 0, JSON.stringify(kyutai));
      s.abort();
    } finally { await srv.close(); }
  }
});
