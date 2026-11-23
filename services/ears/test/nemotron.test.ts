import { test } from "node:test";
import assert from "node:assert/strict";
import { createNemotronEngine } from "../src/nemotron.js";
import type { SttSession } from "../src/engines.js";
import { earsCfg, nemotronServer, sleep, until, type NemotronServer } from "./stt-servers.js";

// The `nemotron` adapter (EARS-NEM-*) against a fake NeMo-Speech.cpp realtime server on a real local socket. Test seam the
// code phase must provide: `createNemotronEngine(cfg)` in src/nemotron.ts (see stt-servers.ts). The session timeout is short
// so the failure cases run in real time.
const TIMEOUT = 300;
const cfgFor = (srv: NemotronServer, over: Record<string, unknown> = {}) =>
  earsCfg({ stt_engine: "nemotron", stt_timeout_ms: TIMEOUT, nemotron: { url: srv.url, ...((over.nemotron as object) ?? {}) }, ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== "nemotron")) });
const connect = async (srv: NemotronServer, over: Record<string, unknown> = {}): Promise<SttSession> =>
  createNemotronEngine(cfgFor(srv, over)).open({ signal: new AbortController().signal });
/** `n` bytes of s16le "audio" of one distinguishing value. */
const pcm = (n: number, v: number) => Buffer.alloc(n, v);

// @spec EARS-NEM-001
test("connects to <url>/v1/audio/transcriptions/realtime, with a bearer only when a key is set", async () => {
  const noKey = await nemotronServer();
  const keyed = await nemotronServer();
  try {
    const a = await connect(noKey);
    const b = await connect(keyed, { nemotron: { api_key: "sekret" } });
    assert.equal(noKey.upgrades.length, 1);
    assert.equal(noKey.upgrades[0]!.url, "/v1/audio/transcriptions/realtime");
    assert.equal(noKey.upgrades[0]!.headers.authorization, undefined, "no key, no Authorization header");
    assert.equal(keyed.upgrades[0]!.url, "/v1/audio/transcriptions/realtime");
    assert.equal(keyed.upgrades[0]!.headers.authorization, "Bearer sekret");
    a.abort(); b.abort();
  } finally { await noKey.close(); await keyed.close(); }
});

// @spec EARS-NEM-001
test("a trailing slash on the URL does not double the path", async () => {
  const srv = await nemotronServer();
  try {
    const s = await createNemotronEngine(cfgFor(srv, { nemotron: { url: `${srv.url}/` } })).open({ signal: new AbortController().signal });
    assert.equal(srv.upgrades[0]!.url, "/v1/audio/transcriptions/realtime");
    s.abort();
  } finally { await srv.close(); }
});

// @spec EARS-NEM-002
test("open() resolves only after session.created, and no session.update is ever sent", async () => {
  const srv = await nemotronServer({ created: 150 });
  try {
    let opened = false;
    const p = createNemotronEngine(cfgFor(srv)).open({ signal: new AbortController().signal }).then((s) => { opened = true; return s; });
    await until(() => srv.upgrades.length === 1, "the connection");
    await sleep(60);
    assert.equal(opened, false, "still waiting for session.created");
    const s = await p;
    assert.equal(opened, true);
    await s.push(pcm(640, 1));
    const fin = s.finish();
    await fin;
    assert.ok(srv.json().every((m) => m.type !== "session.update"), JSON.stringify(srv.json()));
  } finally { await srv.close(); }
});

// @spec EARS-NEM-002, EARS-NEM-006
test("a server that never sends session.created fails open() when its signal aborts", async () => {
  const srv = await nemotronServer({ created: false });
  try {
    const ac = new AbortController();
    const p = createNemotronEngine(cfgFor(srv)).open({ signal: ac.signal });
    const settled = p.then(() => "opened", () => "rejected");
    await until(() => srv.upgrades.length === 1, "the connection");
    setTimeout(() => ac.abort(new Error("bound")), 80);
    assert.equal(await settled, "rejected");
  } finally { await srv.close(); }
});

// @spec EARS-NEM-003
test("each push is one binary 16 kHz PCM16 frame of the same bytes and length, with no resampling", async () => {
  const srv = await nemotronServer();
  try {
    const s = await connect(srv);
    const frames = [pcm(640, 1), pcm(320, 2), pcm(1280, 3)];
    for (const f of frames) await s.push(f);
    await until(() => srv.binary().length === 3, "three binary frames");
    assert.deepEqual(srv.binary().map((b) => b.length), [640, 320, 1280]);
    assert.ok(srv.binary().every((b, i) => b.equals(frames[i]!)), "bytes are exactly what ears pushed");
    assert.equal(srv.json().length, 0, "no text frame carries audio");
    s.abort();
  } finally { await srv.close(); }
});

// @spec EARS-NEM-004
test("deltas build the hypothesis: a suffix is appended, a delta that starts with the hypothesis replaces it", async () => {
  const srv = await nemotronServer();
  try {
    const s = await connect(srv);
    const seen: string[] = [];
    s.onHypothesis((t) => seen.push(t));
    const delta = (d: string) => srv.send({ type: "conversation.item.input_audio_transcription.delta", delta: d });
    delta("hello");              // the first transcript: the whole text
    delta(" wor");              // a suffix of "hello wor"
    delta("ld");                // a suffix of "hello world"
    await until(() => seen.length === 3, "three hypotheses");
    assert.deepEqual(seen, ["hello", "hello wor", "hello world"]);
    delta("hello world!");      // a corrected whole transcript: it starts with the hypothesis "hello world"
    await until(() => seen.length === 4, "the correction");
    assert.equal(seen[3], "hello world!");
    s.abort();
  } finally { await srv.close(); }
});

// @spec EARS-NEM-004
test("a corrected whole transcript that does not start with the hypothesis is appended, as the server's suffix", async () => {
  const srv = await nemotronServer();
  try {
    const s = await connect(srv);
    const seen: string[] = [];
    s.onHypothesis((t) => seen.push(t));
    srv.send({ type: "conversation.item.input_audio_transcription.delta", delta: "turn on" });
    srv.send({ type: "conversation.item.input_audio_transcription.delta", delta: " the lamp" });
    await until(() => seen.length === 2, "two hypotheses");
    assert.deepEqual(seen, ["turn on", "turn on the lamp"]);
    s.abort();
  } finally { await srv.close(); }
});

// @spec EARS-NEM-004
test("known limit: a suffix that begins with the whole hypothesis is read as a correction and replaces it", async () => {
  const srv = await nemotronServer();
  try {
    const s = await connect(srv);
    const seen: string[] = [];
    s.onHypothesis((t) => seen.push(t));
    srv.send({ type: "conversation.item.input_audio_transcription.delta", delta: "no" });
    // the server's suffix for the transcript "no" + "nope" (no space): it begins with "no", so it is read as a whole text
    srv.send({ type: "conversation.item.input_audio_transcription.delta", delta: "nope" });
    await until(() => seen.length === 2, "two hypotheses");
    assert.deepEqual(seen, ["no", "nope"], "the limit: the suffix replaced the hypothesis instead of extending it");
    s.abort();
  } finally { await srv.close(); }
});

// @spec EARS-NEM-005
test("finish() sends input_audio_buffer.commit, resolves with the completed transcript and closes the connection", async () => {
  const srv = await nemotronServer({ transcript: () => "the final text" });
  try {
    const s = await connect(srv);
    await s.push(pcm(640, 1));
    assert.equal(await s.finish(), "the final text");
    const types = srv.json().map((m) => m.type);
    assert.deepEqual(types, ["input_audio_buffer.commit"], "a commit and no clear, update or other text frame");
    await until(() => srv.sockets[0]!.readyState === srv.sockets[0]!.CLOSED || srv.sockets[0]!.readyState === srv.sockets[0]!.CLOSING, "the connection closing");
  } finally { await srv.close(); }
});

// @spec EARS-NEM-005
test("the final is the completed event's transcript, not the last hypothesis", async () => {
  const srv = await nemotronServer({ transcript: () => "from completed" });
  try {
    const s = await connect(srv);
    srv.send({ type: "conversation.item.input_audio_transcription.delta", delta: "from a delta" });
    await sleep(30);
    assert.equal(await s.finish(), "from completed");
  } finally { await srv.close(); }
});

// @spec EARS-NEM-005
test("a session is one utterance: each open() makes its own connection", async () => {
  const srv = await nemotronServer();
  try {
    const e = createNemotronEngine(cfgFor(srv));
    const a = await e.open({ signal: new AbortController().signal });
    await a.finish();
    const b = await e.open({ signal: new AbortController().signal });
    assert.equal(srv.upgrades.length, 2);
    b.abort();
  } finally { await srv.close(); }
});

// @spec EARS-NEM-006
test("an error event fails the session: failed settles with the message and finish() rejects", async () => {
  const srv = await nemotronServer({ transcript: false });
  try {
    const s = await connect(srv);
    const failed = s.failed;
    srv.send({ type: "error", error: { message: "model exploded" } });
    const err = await Promise.race([failed, sleep(1000).then(() => undefined)]);
    assert.ok(err instanceof Error, "failed settled with an Error");
    assert.match(err.message, /model exploded/);
    await assert.rejects(s.finish());
  } finally { await srv.close(); }
});

// @spec EARS-NEM-006
test("a final that does not arrive within ears.stt_timeout_ms fails finish()", async () => {
  const srv = await nemotronServer({ transcript: false });
  try {
    const s = await connect(srv);
    const t0 = Date.now();
    await assert.rejects(s.finish());
    const took = Date.now() - t0;
    assert.ok(took >= TIMEOUT - 30 && took < TIMEOUT * 3, `rejected after ${took} ms`);
    s.abort();
  } finally { await srv.close(); }
});

// @spec EARS-NEM-006
test("a connection that drops during finish() fails the session", async () => {
  const srv = await nemotronServer({ transcript: () => { srv.closeConnection(); return "never"; } });
  try {
    const s = await connect(srv);
    const failed = s.failed;
    const fin = s.finish();
    await assert.rejects(fin);
    assert.ok((await Promise.race([failed, sleep(1000).then(() => undefined)])) instanceof Error, "failed settled");
  } finally { await srv.close(); }
});

// @spec EARS-NEM-006
test("a connection that drops before finish() settles failed", async () => {
  const srv = await nemotronServer();
  try {
    const s = await connect(srv);
    srv.closeConnection();
    assert.ok((await Promise.race([s.failed, sleep(1000).then(() => undefined)])) instanceof Error);
  } finally { await srv.close(); }
});

// @spec EARS-NEM-006
test("a refused connection rejects open() as an outage, not as a capacity refusal", async () => {
  const srv = await nemotronServer();
  const url = srv.url;
  await srv.close();
  const e = createNemotronEngine(earsCfg({ stt_engine: "nemotron", stt_timeout_ms: TIMEOUT, nemotron: { url } }));
  await assert.rejects(e.open({ signal: new AbortController().signal }), (err: Error) => err.name !== "SttCapacityError");
});

// @spec EARS-NEM-007
test("ping(signal) is GET <url>/ready: true for a 2xx answer, false for any other status", async () => {
  let status = 200;
  const srv = await nemotronServer({ ready: () => status });
  try {
    const e = createNemotronEngine(cfgFor(srv));
    assert.equal(typeof e.ping, "function", "the engine has a readiness probe (EARS-HLTH-008)");
    assert.equal(await e.ping!(new AbortController().signal), true);
    assert.equal(srv.readyGets.length, 1);
    assert.equal(srv.readyGets[0]!.url, "/ready");
    status = 503;
    assert.equal(await e.ping!(new AbortController().signal), false);
  } finally { await srv.close(); }
});

// @spec EARS-NEM-007
test("ping(signal) is not ready when the server is unreachable, and ends when its signal aborts", async () => {
  const dead = await nemotronServer();
  const url = dead.url;
  await dead.close();
  const e = createNemotronEngine(earsCfg({ stt_engine: "nemotron", stt_timeout_ms: TIMEOUT, nemotron: { url } }));
  assert.equal(await e.ping!(new AbortController().signal).catch(() => false), false);

  // a /ready that never answers is cut off by the abort
  const { createServer } = await import("node:http");
  const hang = createServer(() => {});
  await new Promise<void>((r) => hang.listen(0, "127.0.0.1", r));
  try {
    const port = (hang.address() as { port: number }).port;
    const slow = createNemotronEngine(earsCfg({ stt_engine: "nemotron", nemotron: { url: `http://127.0.0.1:${port}` } }));
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 80);
    const t0 = Date.now();
    assert.equal(await slow.ping!(ac.signal).catch(() => false), false);
    assert.ok(Date.now() - t0 < 1000, "the probe ended on abort");
  } finally { hang.closeAllConnections(); hang.close(); }
});

// @spec EARS-NEM-005
test("an empty utterance: committed with no completed event is an empty final, not a failure", async () => {
  const srv = await nemotronServer({ transcript: () => null });
  try {
    const s = await connect(srv);
    const failed = s.failed;
    await s.push(pcm(640, 1));
    const t0 = Date.now();
    assert.equal(await s.finish(), "");
    assert.ok(Date.now() - t0 < TIMEOUT, "resolved on committed, not at the bound");
    assert.equal(await Promise.race([failed, sleep(30).then(() => "not failed")]), "not failed");
  } finally { await srv.close(); }
});

// @spec EARS-NEM-005
test("a completed event before the commit (server endpointing) is kept: the final joins the segments in order", async () => {
  const srv = await nemotronServer({ transcript: () => "second part", endpointText: "first part" });
  try {
    const s = await connect(srv);
    await s.push(pcm(640, 1));
    await until(() => srv.binary().length === 1, "the first frame");
    await sleep(30);
    await s.push(pcm(640, 2));
    assert.equal(await s.finish(), "first part second part");
  } finally { await srv.close(); }
});
