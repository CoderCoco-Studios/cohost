import "./helpers/dom";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAudio } from "../../ui/src/state/audio";
import { createFeed } from "../../ui/src/state/feed";
import type { FeedEvent } from "../../ui/src/state/types";
import { FakeAudio, FakeClock, FakeSocket } from "./helpers/fakes";

function setup(opts: { enabled?: boolean } = {}) {
  FakeSocket.reset(); FakeAudio.reset();
  const clock = new FakeClock();
  const feed = createFeed({ url: "ws://x/ws", createSocket: (u) => new FakeSocket(u) as unknown as WebSocket, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, now: () => clock.now });
  feed.start(); FakeSocket.last().open();
  const posts: { event: string; id: string }[] = [];
  const audio = createAudio({ feed, sink: async (event, id) => { posts.push({ event, id }); }, createAudio: (src) => new FakeAudio(src) as unknown as HTMLAudioElement, enabled: opts.enabled });
  const push = (id: string, uid: string, replay = false) => FakeSocket.last().message({ id, type: "voice.utterance", ts: 1, source: "voice", data: { id: uid, durationMs: 10 }, ...(replay ? { replay: true } : {}) } satisfies FeedEvent);
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { audio, posts, push, flush };
}

// @spec DASH-UI-012
test("while audio is on, an utterance plays /audio/<id>.wav, posts playing on start and done on end, then the next one plays", async () => {
  const { audio, posts, push, flush } = setup({ enabled: true });
  push("1-0", "u1"); push("2-0", "u2");
  await flush();
  assert.equal(FakeAudio.instances.length, 1);
  assert.equal(FakeAudio.instances[0]!.src, "/audio/u1.wav");
  assert.deepEqual(posts, [{ event: "playing", id: "u1" }]);
  FakeAudio.instances[0]!.end();
  await flush();
  assert.deepEqual(posts.at(-2), { event: "done", id: "u1" });
  assert.equal(FakeAudio.instances[1]!.src, "/audio/u2.wav");
  FakeAudio.instances[1]!.fail();
  await flush();
  assert.deepEqual(posts.at(-1), { event: "done", id: "u2" });
  assert.equal(audio.state.get().playing, null);
});

// @spec DASH-UI-013
test("an utterance delivered in the connect replay is never played and posts nothing; the same id live and replayed plays once", async () => {
  const { posts, push, flush } = setup({ enabled: true });
  push("1-0", "old", true);
  await flush();
  assert.equal(FakeAudio.instances.length, 0);
  assert.deepEqual(posts, []);
  push("2-0", "new"); push("2-0", "new", true);
  await flush();
  assert.equal(FakeAudio.instances.length, 1);
});

// @spec DASH-UI-014
test("while audio is off nothing is queued; turning it off by hand drops what has not started", async () => {
  const { audio, push, flush } = setup({ enabled: false });
  push("1-0", "a"); push("2-0", "b");
  assert.equal(audio.state.get().queued, 0);
  audio.enable();
  push("3-0", "c"); push("4-0", "d"); push("5-0", "e");
  await flush();
  assert.equal(audio.state.get().queued, 2);
  audio.disable();
  assert.equal(audio.state.get().queued, 0);
  assert.equal(audio.state.get().enabled, false);
});

// @spec DASH-UI-022, DASH-UI-012
test("if the browser refuses to start playback, that utterance is reported done once, audio switches off, and the queue is kept for when it is switched on", async () => {
  const { audio, posts, push, flush } = setup({ enabled: true });
  FakeAudio.refuse = true;
  push("1-0", "a"); push("2-0", "b");
  await flush();
  assert.equal(audio.state.get().enabled, false);
  assert.deepEqual(posts, [{ event: "done", id: "a" }]);
  assert.equal(audio.state.get().queued, 1);
  FakeAudio.refuse = false;
  audio.enable();
  await flush();
  assert.equal(FakeAudio.instances.at(-1)!.src, "/audio/b.wav");
});

// @spec DASH-UI-011
test("a sink page starts with audio on", () => {
  assert.equal(setup({ enabled: true }).audio.state.get().enabled, true);
  assert.equal(setup().audio.state.get().enabled, false);
});
