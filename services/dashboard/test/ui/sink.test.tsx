import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { renderApp, makeApp, screen, userEvent, act, waitFor, type TestApp } from "./helpers/render";
import { FakeAudio } from "./helpers/fakes";
import { App } from "../../ui/src/app/App";
import { isSinkLocation } from "../../ui/src/app/SinkView";

beforeEach(() => FakeAudio.reset());

function boot(over: { open?: boolean; name?: string } = {}) {
  location.hash = "";
  document.head.innerHTML = `<meta name="cohost-name" content="${over.name ?? "Coco"}">`;
  const app = makeApp({ sink: true, createAudio: (src) => new FakeAudio(src) as unknown as HTMLAudioElement });
  app.fetch.on("POST /sink", { status: 204 });
  const r = renderApp(<App sink />, app);
  if (over.open !== false) act(() => { app.socket().open(); });
  return Object.assign(r, { app });
}
let seq = 0;
const frame = (app: TestApp, type: string, data: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  act(() => { app.socket().message({ id: `s${++seq}-0`, type, ts: 1, source: "t", data, ...extra }); });
const utterance = (app: TestApp, id: string, extra: Record<string, unknown> = {}) => frame(app, "voice.utterance", { id, seq: 0, durationMs: 10 }, extra);
const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const sinkCalls = (app: TestApp) => app.fetch.callsTo("POST /sink").map((c) => JSON.parse(c.body!) as Record<string, unknown>);
const line = () => screen.getByRole("status").textContent!;

// @spec DASH-UI-011
test("any sink query parameter, whatever its value, selects the sink view", () => {
  for (const q of ["?sink=1", "?sink=0", "?sink", "?a=1&sink=", "?sink=true"]) assert.equal(isSinkLocation(q), true, q);
  for (const q of ["", "?", "?sinks=1", "?a=sink", "#sink"]) assert.equal(isSinkLocation(q), false, q);
});

// @spec DASH-UI-011
test("the sink view is the brand, the audio state and a one-line status, with audio on and no navigation, heading or link", () => {
  boot();
  const main = screen.getByRole("main");
  assert.equal(main.querySelector(".brand-name")!.textContent, "Coco");
  assert.match(main.textContent!, /Audio on/);
  assert.equal(line(), "Connected");
  assert.equal(document.querySelectorAll("nav, a, h1, h2, header, dialog").length, 0);
  assert.equal(screen.queryAllByRole("button").length, 0, "audio is on, so there is nothing to press");
});

// @spec DASH-UI-011, DASH-UI-030
test("the co-host's name is text, never markup", () => {
  boot({ name: "&lt;b&gt;Coco&lt;/b&gt;" });
  assert.ok(document.querySelector("main b") === null);
  assert.equal(document.querySelector(".brand-name")!.textContent, "<b>Coco</b>");
});

// @spec DASH-UI-011
test("the one-line status follows the socket: connecting, connected, reconnecting", () => {
  const { app } = boot({ open: false });
  assert.equal(line(), "Connecting…");
  act(() => { app.socket().open(); });
  assert.equal(line(), "Connected");
  act(() => { app.socket().serverClose(); });
  assert.equal(line(), "Reconnecting…");
});

// @spec DASH-UI-011, DASH-HOST-002
test("whatever the feed carries, the sink page makes no request of its own", async () => {
  const { app } = boot();
  frame(app, "services", {}, {});
  act(() => { app.socket().message({ type: "services", services: [{ service: "voice", state: "up", restarts: 0 }] }); });
  act(() => { app.socket().message({ type: "stack", state: "up", docker: { ok: true }, bus: "connected", action: null, last: null, services: [] }); });
  for (const t of ["chat.message", "brain.say", "avatar.state", "brain.status", "inject.result", "control"]) frame(app, t, { text: "x", state: "idle", id: "z" });
  await tick();
  assert.deepEqual(app.fetch.calls, []);
});

// @spec DASH-UI-011, DASH-UI-012
test("a live utterance is played from /audio/<id>.wav, posts playing then done to /sink, and shows Playing meanwhile", async () => {
  const { app } = boot();
  utterance(app, "u1");
  await tick();
  assert.equal(FakeAudio.instances[0]!.src, "/audio/u1-0.wav");
  assert.equal(line(), "Playing");
  act(() => FakeAudio.instances[0]!.end());
  await tick();
  assert.equal(line(), "Connected");
  assert.deepEqual(sinkCalls(app), [{ event: "playing", id: "u1", seq: 0 }, { event: "done", id: "u1", seq: 0 }]);
  assert.deepEqual(app.fetch.calls.map((c) => `${c.method} ${c.path}`), ["POST /sink", "POST /sink"]);
});

// @spec DASH-UI-011, DASH-UI-012
test("lines that arrive while one plays wait their turn, and the status says how many wait", async () => {
  const { app } = boot();
  utterance(app, "u1"); utterance(app, "u2"); utterance(app, "u3");
  await tick();
  assert.equal(FakeAudio.instances.length, 1);
  assert.equal(line(), "Playing · 2 waiting");
  act(() => FakeAudio.instances[0]!.end());
  await tick();
  assert.equal(FakeAudio.instances[1]!.src, "/audio/u2-0.wav");
  assert.equal(line(), "Playing · 1 waiting");
});

// @spec DASH-UI-013
test("a replayed utterance and a repeated event id are never played again", async () => {
  const { app } = boot();
  utterance(app, "old", { replay: true });
  await tick();
  assert.equal(FakeAudio.instances.length, 0);
  act(() => { app.socket().message({ id: "dup-0", type: "voice.utterance", ts: 1, source: "t", data: { id: "d1", seq: 0 } }); app.socket().message({ id: "dup-0", type: "voice.utterance", ts: 1, source: "t", data: { id: "d1", seq: 0 } }); });
  await tick();
  assert.equal(FakeAudio.instances.length, 1);
  assert.deepEqual(sinkCalls(app), [{ event: "playing", id: "d1", seq: 0 }]);
});

// @spec DASH-UI-022, DASH-UI-052, DASH-UI-012
test("when the browser refuses playback the refused clause is posted final, the view says audio is off with a button, and the queue plays after it is turned on", async () => {
  const user = userEvent.setup();
  const { app } = boot();
  FakeAudio.refuse = true;
  utterance(app, "u1"); utterance(app, "u2");
  await tick();
  assert.deepEqual(sinkCalls(app), [{ event: "done", id: "u1", seq: 0, final: true }], "clause 0 was refused: final releases voice at once (DASH-UI-052)");
  assert.match(document.body.textContent!, /Audio off/);
  assert.match(line(), /1 waiting/);
  assert.match(document.body.textContent!, /turn audio on to play the lines that are waiting/i);
  FakeAudio.refuse = false;
  await user.click(screen.getByRole("button", { name: "Turn audio on" }));
  await tick();
  await waitFor(() => assert.equal(FakeAudio.instances.at(-1)!.src, "/audio/u2-0.wav"));
  assert.match(document.body.textContent!, /Audio on/);
  assert.ok(sinkCalls(app).some((c) => c.event === "playing" && c.id === "u2" && c.seq === 0));
  assert.equal(screen.queryAllByRole("button").length, 0);
});

// @spec DASH-UI-014, DASH-UI-011
test("an audio error ends the line with done and the next one plays", async () => {
  const { app } = boot();
  utterance(app, "u1"); utterance(app, "u2");
  await tick();
  act(() => FakeAudio.instances[0]!.fail());
  await tick();
  assert.deepEqual(sinkCalls(app).slice(0, 2), [{ event: "playing", id: "u1", seq: 0 }, { event: "done", id: "u1", seq: 0 }]);
  assert.equal(FakeAudio.instances[1]!.src, "/audio/u2-0.wav");
});

// @spec DASH-UI-011, DASH-A11Y-004
test("the status line is a polite status region, and the audio state is text beside an icon that is hidden from assistive technology", () => {
  boot();
  assert.equal(screen.getByRole("status").tagName, "P");
  assert.equal(document.querySelector(".sink-audio svg")!.getAttribute("aria-hidden"), "true");
});

// @spec DASH-UI-011, DASH-UI-012, DASH-UI-043, DASH-UI-046
test("a streamed line plays clause by clause from /audio/<id>-<seq>.wav, posting each clause's playing and done with its seq, and makes no other request", async () => {
  const { app } = boot();
  frame(app, "voice.utterance", { id: "L", seq: 0, text: "A.", durationMs: 10, more: true });
  frame(app, "voice.utterance", { id: "L", seq: 1, text: "B.", durationMs: 10 });
  frame(app, "brain.clause", { id: "L", seq: 2, text: "", last: true, through: 1 });
  await tick();
  act(() => FakeAudio.instances[0]!.end());
  await tick();
  act(() => FakeAudio.instances[1]!.end());
  await tick();
  assert.deepEqual(FakeAudio.instances.map((a) => a.src), ["/audio/L-0.wav", "/audio/L-1.wav"]);
  assert.deepEqual(sinkCalls(app), [
    { event: "playing", id: "L", seq: 0 }, { event: "done", id: "L", seq: 0 },
    { event: "playing", id: "L", seq: 1 }, { event: "done", id: "L", seq: 1 },
  ]);
  assert.deepEqual(app.fetch.calls.map((c) => `${c.method} ${c.path}`), ["POST /sink", "POST /sink", "POST /sink", "POST /sink"]);
});

// @spec DASH-UI-011, DASH-UI-047, DASH-UI-048
test("a live voice.stop on the sink page cuts the clip and posts the interrupted done to /sink", async () => {
  const { app } = boot();
  frame(app, "voice.utterance", { id: "L", seq: 0, text: "one two three four", durationMs: 10, more: true });
  await tick();
  FakeAudio.instances[0]!.currentTime = 5;
  frame(app, "voice.stop", { reason: "barge-in" });
  await tick();
  assert.equal(FakeAudio.instances[0]!.paused, true);
  assert.deepEqual(sinkCalls(app).at(-1), { event: "done", id: "L", seq: 0, interrupted: true, spokenText: "one two", unsaidText: "three four" });
});
