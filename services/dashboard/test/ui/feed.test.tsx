import "./helpers/dom";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFeed, FEED_TYPES } from "../../ui/src/state/feed";
import type { FeedEvent } from "../../ui/src/state/types";
import { FakeClock, FakeSocket } from "./helpers/fakes";

function setup(url = "ws://localhost:3000/ws") {
  FakeSocket.reset();
  const clock = new FakeClock();
  const feed = createFeed({ url, createSocket: (u) => new FakeSocket(u) as unknown as WebSocket, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, now: () => clock.now });
  feed.start();
  return { feed, clock, sock: () => FakeSocket.last() };
}
const ev = (id: string, type: string, data: Record<string, unknown> = {}, extra: Partial<FeedEvent> = {}): FeedEvent => ({ id, type, ts: 1, source: "t", data, ...extra });

// @spec DASH-UI-001
test("the feed opens /ws at the page's origin, using wss over HTTPS", () => {
  const { sock } = setup("ws://localhost:3000/ws");
  assert.equal(sock().url, "ws://localhost:3000/ws");
  FakeSocket.reset();
  const clock = new FakeClock();
  createFeed({ url: "wss://host/ws", createSocket: (u) => new FakeSocket(u) as unknown as WebSocket, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, now: () => clock.now }).start();
  assert.equal(FakeSocket.last().url, "wss://host/ws");
});

test("status goes connecting, then open; the snapshots arrive as services and stack messages", () => {
  const { feed, sock } = setup();
  assert.equal(feed.state.get().status, "connecting");
  assert.equal(feed.state.get().services, null);
  sock().open();
  assert.equal(feed.state.get().status, "open");
  sock().message({ type: "services", services: [{ service: "voice", state: "up", restarts: 0 }] });
  sock().message({ type: "stack", state: "up", docker: { ok: true }, bus: "connected", action: null, last: null, services: [] });
  assert.equal(feed.state.get().services?.[0]?.service, "voice");
  assert.equal(feed.state.get().stack?.state, "up");
  assert.equal(feed.state.get().servicesAt, 1_700_000_000_000);
});

// @spec DASH-UI-001
test("a frame that is not valid JSON is dropped without throwing", () => {
  const { feed, sock } = setup();
  sock().open();
  assert.doesNotThrow(() => { sock().message("{not json"); sock().message("null"); sock().message("42"); });
  assert.equal(feed.state.get().events.length, 0);
});

// @spec DASH-UI-013
test("a replayed event is flagged as a replay for every listener and a live one is not", () => {
  const { feed, sock } = setup();
  const seen: [string, boolean][] = [];
  feed.onEvent((e, replay) => seen.push([e.id, replay]));
  sock().open();
  sock().message(ev("1-0", "voice.utterance", { id: "u1" }, { replay: true }));
  sock().message(ev("2-0", "voice.utterance", { id: "u2" }));
  assert.deepEqual(seen, [["1-0", true], ["2-0", false]]);
});

// @spec DASH-UI-013
test("each bus event id is handled once: an event delivered live and again in a replay reaches listeners and the log once", () => {
  const { feed, clock, sock } = setup();
  let n = 0;
  feed.onEvent(() => { n++; });
  sock().open();
  sock().message(ev("5-0", "chat.message", { text: "hi" }));
  sock().message(ev("5-0", "chat.message", { text: "hi" }, { replay: true }));
  sock().serverClose(); clock.tick(2000); sock().open();
  sock().message(ev("5-0", "chat.message", { text: "hi" }, { replay: true }));
  assert.equal(n, 1);
  assert.equal(feed.state.get().events.length, 1);
});

// @spec DASH-UI-002
test("the log keeps rows only for the rendered event types and at most 300 of them", () => {
  const { feed, sock } = setup();
  sock().open();
  sock().message(ev("1-0", "attention.focus"));
  sock().message(ev("2-0", "affect.state"));
  sock().message(ev("3-0", "chat.message", { text: "x" }));
  assert.deepEqual(feed.state.get().events.map((e) => e.id), ["3-0"]);
  for (let i = 0; i < 350; i++) sock().message(ev(`${10 + i}-0`, "brain.say", { text: String(i) }));
  const ids = feed.state.get().events.map((e) => e.id);
  assert.equal(ids.length, 300);
  assert.equal(ids.at(-1), "359-0");
  assert.deepEqual([...FEED_TYPES].sort(), ["brain.say", "brain.status", "chat.message", "control", "inject.request", "inject.result", "service.lifecycle", "speech.heard", "vision.summary", "voice.done", "voice.playing", "voice.utterance"]);
});

// @spec DASH-UI-003
test("brain.status and avatar.state are kept as the latest of their type", () => {
  const { feed, sock } = setup();
  sock().open();
  sock().message(ev("1-0", "brain.status", { state: "thinking", detail: "x" }));
  sock().message(ev("2-0", "brain.status", { state: "idle" }));
  sock().message(ev("3-0", "avatar.state", { driver: "vts", connected: true }));
  assert.equal(feed.state.get().latest["brain.status"]?.data.state, "idle");
  assert.equal(feed.state.get().latest["avatar.state"]?.data.driver, "vts");
});

// @spec DASH-UI-005
test("mute state is inferred from the latest mute or unmute control event, live or in the replay; unmuted until one is seen", () => {
  const { feed, sock } = setup();
  assert.equal(feed.state.get().muted, false);
  sock().open();
  sock().message(ev("1-0", "control", { cmd: "mute" }, { replay: true }));
  assert.equal(feed.state.get().muted, true);
  sock().message(ev("2-0", "control", { cmd: "say", text: "hi" }));
  assert.equal(feed.state.get().muted, true);
  sock().message(ev("3-0", "control", { cmd: "unmute" }));
  assert.equal(feed.state.get().muted, false);
  sock().message(ev("4-0", "control", { cmd: "mute" }));
  assert.equal(feed.state.get().muted, true);
});

// @spec DASH-UI-001
test("when the socket closes the feed records when it stopped and when the next attempt is, and reconnects after 2 s", () => {
  const { feed, clock, sock } = setup();
  sock().open();
  clock.tick(500);
  const stoppedAt = clock.now;
  sock().serverClose();
  const s = feed.state.get();
  assert.equal(s.status, "closed");
  assert.equal(s.stoppedAt, stoppedAt);
  assert.equal(s.nextAttemptAt, stoppedAt + 2000);
  assert.equal(FakeSocket.instances.length, 1);
  clock.tick(1999);
  assert.equal(FakeSocket.instances.length, 1);
  clock.tick(1);
  assert.equal(FakeSocket.instances.length, 2);
  assert.equal(feed.state.get().status, "connecting");
  FakeSocket.last().open();
  const after = feed.state.get();
  assert.equal(after.status, "open");
  assert.equal(after.stoppedAt, undefined);
  assert.equal(after.nextAttemptAt, undefined);
});

// @spec DASH-UI-001
test("a failed attempt keeps retrying every 2 s", () => {
  const { clock } = setup();
  for (let i = 0; i < 3; i++) { FakeSocket.last().serverClose(); clock.tick(2000); }
  assert.equal(FakeSocket.instances.length, 4);
});

// @spec DASH-UI-013
test("a reconnect's replay does not duplicate rows already shown", () => {
  const { feed, clock, sock } = setup();
  sock().open();
  sock().message(ev("1-0", "chat.message", { text: "a" }));
  sock().serverClose();
  clock.tick(2000);
  sock().open();
  sock().message(ev("1-0", "chat.message", { text: "a" }, { replay: true }));
  sock().message(ev("2-0", "chat.message", { text: "b" }, { replay: true }));
  assert.deepEqual(feed.state.get().events.map((e) => e.id), ["1-0", "2-0"]);
});

test("stop closes the socket and does not reconnect", () => {
  const { feed, clock, sock } = setup();
  sock().open();
  feed.stop();
  clock.tick(10_000);
  assert.equal(FakeSocket.instances.length, 1);
});

test("an unsubscribed listener hears nothing more", () => {
  const { feed, sock } = setup();
  let n = 0;
  const off = feed.onEvent(() => { n++; });
  sock().open();
  sock().message(ev("1-0", "chat.message"));
  off();
  sock().message(ev("2-0", "chat.message"));
  assert.equal(n, 1);
});

// @spec DASH-UI-001
test("a socket constructor that throws does not spin: the feed is closed and retries once per 2 s", () => {
  const clock = new FakeClock();
  let attempts = 0;
  const feed = createFeed({ url: "ws://x/ws", createSocket: () => { attempts++; throw new Error("blocked"); }, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, now: () => clock.now });
  feed.start();
  assert.equal(attempts, 1);
  assert.equal(feed.state.get().status, "closed");
  clock.tick(2000); assert.equal(attempts, 2);
  clock.tick(1999); assert.equal(attempts, 2);
  feed.stop();
  clock.tick(10_000); assert.equal(attempts, 2);
});
