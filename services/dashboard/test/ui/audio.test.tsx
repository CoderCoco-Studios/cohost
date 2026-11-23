import "./helpers/dom";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAudio } from "../../ui/src/state/audio";
import { createFeed } from "../../ui/src/state/feed";
import type { FeedEvent } from "../../ui/src/state/types";
import { FakeAudio, FakeClock, FakeSocket } from "./helpers/fakes";

/** What the page posts to `/sink` for one report: the `sink` dependency receives this object (the body of `POST /sink`). */
type Report = { event: string; id: string; seq: number; interrupted?: true; final?: true; spokenText?: string; unsaidText?: string };

function setup(opts: { enabled?: boolean } = {}) {
  FakeSocket.reset(); FakeAudio.reset();
  const clock = new FakeClock();
  const feed = createFeed({ url: "ws://x/ws", createSocket: (u) => new FakeSocket(u) as unknown as WebSocket, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, now: () => clock.now });
  feed.start(); FakeSocket.last().open();
  const posts: Report[] = [];
  const unload = new EventTarget();
  const audio = createAudio({
    feed, sink: async (r: Report) => { posts.push(r); }, createAudio: (src: string) => new FakeAudio(src) as unknown as HTMLAudioElement, enabled: opts.enabled,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, target: unload,
  } as unknown as Parameters<typeof createAudio>[0]);
  let n = 0;
  const frame = (type: string, data: Record<string, unknown>, replay = false) =>
    FakeSocket.last().message({ id: `e${++n}-0`, type, ts: 1, source: "t", data, ...(replay ? { replay: true } : {}) } satisfies FeedEvent);
  const utt = (id: string, seq: number, text = `t${seq}`, o: { more?: boolean; replay?: boolean } = {}) =>
    frame("voice.utterance", { id, seq, text, durationMs: 10, ...(o.more ? { more: true } : {}) }, o.replay);
  const clause = (id: string, seq: number, text: string, o: { last?: boolean; through?: number } = {}) =>
    frame("brain.clause", { id, seq, text, ...(o.last ? { last: true, through: o.through ?? seq } : {}) });
  const stop = (ids?: string[], replay = false) => frame("voice.stop", { reason: "barge-in", ...(ids ? { ids } : {}) }, replay);
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const clip = (i: number) => FakeAudio.instances[i]!;
  return { audio, posts, utt, clause, stop, flush, clock, clip, unload };
}
const srcs = () => FakeAudio.instances.map((a) => a.src);

// @spec DASH-UI-012
test("while audio is on, a clause plays /audio/<id>-<seq>.wav, posts playing then done with its id and seq, then the next one plays", async () => {
  const { audio, posts, utt, flush, clip } = setup({ enabled: true });
  utt("u1", 0); utt("u2", 0);
  await flush();
  assert.deepEqual(srcs(), ["/audio/u1-0.wav"]);
  assert.deepEqual(posts, [{ event: "playing", id: "u1", seq: 0 }]);
  clip(0).end();
  await flush();
  assert.deepEqual(posts.slice(0, 2), [{ event: "playing", id: "u1", seq: 0 }, { event: "done", id: "u1", seq: 0 }]);
  assert.equal(clip(1).src, "/audio/u2-0.wav");
  clip(1).fail();
  await flush();
  assert.deepEqual(posts.at(-1), { event: "done", id: "u2", seq: 0 });
  assert.equal(audio.state.get().playing, null);
});

// @spec DASH-UI-012
test("the key of the audio URL is URL-encoded, so an id with a slash, a question mark or a space cannot change the path", async () => {
  const { utt, flush } = setup({ enabled: true });
  utt("../x?y=1 z#h", 0);
  await flush();
  assert.equal(FakeAudio.instances[0]!.src, `/audio/${encodeURIComponent("../x?y=1 z#h")}-0.wav`);
});

// @spec DASH-UI-013
test("an utterance delivered in the connect replay is never played and posts nothing", async () => {
  const { posts, utt, flush } = setup({ enabled: true });
  utt("old", 0, "x", { replay: true });
  await flush();
  assert.equal(FakeAudio.instances.length, 0);
  assert.deepEqual(posts, []);
});

// @spec DASH-UI-046, DASH-UI-012
test("clauses play in arrival order, one at a time, and the page does not wait for a clause that has not arrived", async () => {
  const { utt, flush, clip } = setup({ enabled: true });
  utt("a", 0, "A0", { more: true }); utt("a", 2, "A2"); utt("b", 0, "B0"); utt("a", 3, "A3");
  await flush();
  assert.equal(FakeAudio.instances.length, 1);
  clip(0).end(); await flush(); // clause 1 of a never arrives: the next clip is a's clause 2, with no wait
  clip(1).end(); await flush();
  clip(2).end(); await flush();
  assert.deepEqual(srcs(), ["/audio/a-0.wav", "/audio/a-2.wav", "/audio/b-0.wav", "/audio/a-3.wav"]);
});

// @spec DASH-UI-014
test("while audio is off nothing is queued; turning it off by hand drops what has not started", async () => {
  const { audio, utt, flush } = setup({ enabled: false });
  utt("a", 0); utt("b", 0);
  assert.equal(audio.state.get().queued, 0);
  audio.enable();
  utt("c", 0); utt("d", 0); utt("e", 0);
  await flush();
  assert.equal(audio.state.get().queued, 2);
  audio.disable();
  assert.equal(audio.state.get().queued, 0);
  assert.equal(audio.state.get().enabled, false);
});

// @spec DASH-UI-011
test("a sink page starts with audio on", () => {
  assert.equal(setup({ enabled: true }).audio.state.get().enabled, true);
  assert.equal(setup().audio.state.get().enabled, false);
});

// @spec DASH-UI-043, DASH-UI-044
test("a streamed line is open from the page's own playing post for clause 0; a closing clause drops the queued clauses above through, and when through has finished the line has ended and gets nothing", async () => {
  const { posts, utt, clause, stop, flush, clip } = setup({ enabled: true });
  utt("L", 0, "A", { more: true }); utt("L", 1, "B"); utt("L", 2, "C"); utt("L", 3, "D");
  await flush();
  clip(0).end(); await flush();
  clause("L", 4, "", { last: true, through: 1 });
  clip(1).end(); await flush();
  assert.deepEqual(srcs(), ["/audio/L-0.wav", "/audio/L-1.wav"], "clauses 2 and 3 are above through and never play");
  const before = posts.length;
  stop(); await flush();
  assert.equal(posts.length, before, "an ended line gets nothing");
});

// @spec DASH-UI-044
test("when through has already finished at the closing clause the line ends at once, and a later clause of it is dropped", async () => {
  const { posts, utt, clause, stop, flush, clip } = setup({ enabled: true });
  utt("L", 0, "A", { more: true }); utt("L", 1, "B");
  await flush();
  clip(0).end(); await flush(); clip(1).end(); await flush();
  clause("L", 2, "", { last: true, through: 1 });
  utt("L", 2, "late");
  await flush();
  assert.equal(FakeAudio.instances.length, 2);
  const before = posts.length;
  stop(); await flush();
  assert.equal(posts.length, before);
});

// @spec DASH-UI-044
test("a line with no clause activity ends after 300 s: a stop at 299 s gets an interrupted done, a stop at 300 s gets nothing", async () => {
  for (const [ms, expected] of [[299_000, 1], [300_000, 0]] as const) {
    const { posts, utt, stop, flush, clip, clock } = setup({ enabled: true });
    utt("L", 0, "A", { more: true });
    await flush();
    clip(0).end(); await flush();
    const before = posts.length;
    clock.tick(ms); stop(); await flush();
    assert.equal(posts.length - before, expected, `after ${ms} ms`);
  }
});

// @spec DASH-UI-045
test("a line whose clause 0 the page did not play (audio off, or only in the replay) is skipped: later clauses never play and nothing is posted", async () => {
  const { audio, posts, utt, stop, flush } = setup({ enabled: false });
  utt("off", 0, "A", { more: true });
  audio.enable();
  utt("off", 1, "B"); utt("rep", 0, "A", { more: true, replay: true }); utt("rep", 1, "B");
  stop(); await flush();
  assert.equal(FakeAudio.instances.length, 0);
  assert.deepEqual(posts, []);
});

// @spec DASH-UI-047, DASH-UI-048, DASH-UI-050
test("a live voice.stop naming a line drops its queued and later clauses, stops its clip and posts one interrupted done with the split; other lines stay queued", async () => {
  const { posts, utt, stop, flush, clip } = setup({ enabled: true });
  utt("L", 0, "A.", { more: true }); utt("L", 1, "one two three four"); utt("L", 2, "C."); utt("M", 0, "other");
  await flush();
  clip(0).end(); await flush(); // clause 1 plays now
  clip(1).currentTime = 5; clip(1).duration = 10;
  const before = posts.length;
  stop(["L"]); await flush();
  assert.equal(clip(1).paused, true);
  assert.deepEqual(posts.slice(before).filter((p) => p.id === "L"), [{ event: "done", id: "L", seq: 1, interrupted: true, spokenText: "A. one two", unsaidText: "three four C." }]);
  utt("L", 3, "late"); await flush();
  assert.equal(srcs().includes("/audio/L-3.wav"), false);
  assert.deepEqual(posts.slice(before).filter((p) => p.id === "M"), [{ event: "playing", id: "M", seq: 0 }]);
  assert.equal(srcs().at(-1), "/audio/M-0.wav");
});

// @spec DASH-UI-047
test("a voice.stop naming no line covers every line", async () => {
  const { posts, utt, stop, flush, clip } = setup({ enabled: true });
  utt("L", 0, "A", { more: true }); utt("M", 0, "B");
  await flush();
  stop(); await flush();
  assert.equal(clip(0).paused, true);
  assert.equal(FakeAudio.instances.length, 1, "the queued line was dropped");
  assert.equal(posts.filter((p) => p.interrupted).length, 1);
});

// @spec DASH-UI-049
test("a stop between two clauses of a line the page started posts the interrupted done for the last clause it played; a line it never started gets nothing", async () => {
  const { posts, utt, stop, flush, clip } = setup({ enabled: true });
  utt("L", 0, "First.", { more: true });
  await flush();
  clip(0).end(); await flush();
  const before = posts.length;
  stop(["L", "never"]); await flush();
  const sent = posts.slice(before);
  assert.equal(sent.length, 1);
  assert.deepEqual({ ...sent[0], unsaidText: sent[0]!.unsaidText ?? "" }, { event: "done", id: "L", seq: 0, interrupted: true, spokenText: "First.", unsaidText: "" });
});

// @spec DASH-UI-053
test("a voice.stop delivered in the connect replay is ignored", async () => {
  const { posts, utt, stop, flush, clip } = setup({ enabled: true });
  utt("L", 0, "A", { more: true });
  await flush();
  stop(undefined, true); await flush();
  assert.equal(clip(0).paused, false);
  assert.deepEqual(posts, [{ event: "playing", id: "L", seq: 0 }]);
});

// @spec DASH-UI-051
test("switching audio off by hand posts one final done for an open line with the seq of the first clause it will not play", async () => {
  const { audio, posts, utt, flush, clip } = setup({ enabled: true });
  utt("L", 0, "A", { more: true });
  await flush();
  clip(0).end(); await flush(); // clause 0 finished, clause 1 not here yet
  audio.disable(); audio.disable();
  await flush();
  const finals = posts.filter((p) => p.final);
  assert.deepEqual(finals, [{ event: "done", id: "L", seq: 1, final: true }]);
});

// @spec DASH-UI-051
test("switching audio off posts nothing for a queued utterance of a line that is not open", async () => {
  const { audio, posts, utt, flush } = setup({ enabled: true });
  utt("A", 0); utt("N", 0, "queued only");
  await flush();
  audio.disable(); await flush();
  assert.equal(posts.some((p) => p.id === "N"), false);
});

// @spec DASH-UI-051
test("unloading the page posts one final done for an open line, once", async () => {
  const { posts, utt, flush, clip, unload } = setup({ enabled: true });
  utt("L", 0, "A", { more: true }); utt("L", 1, "B");
  await flush();
  clip(0).end(); await flush();
  clip(1).end(); await flush();
  unload.dispatchEvent(new Event("pagehide")); unload.dispatchEvent(new Event("pagehide"));
  assert.deepEqual(posts.filter((p) => p.final), [{ event: "done", id: "L", seq: 2, final: true }]);
});

// @spec DASH-UI-052, DASH-UI-022
test("a refused clause of an open line turns audio off, drops only that line's queue, keeps other utterances and posts final for the refused clause", async () => {
  const { audio, posts, utt, flush, clip } = setup({ enabled: true });
  utt("L", 0, "A", { more: true }); utt("L", 1, "B"); utt("L", 2, "C"); utt("M", 0, "other");
  await flush();
  FakeAudio.refuse = true;
  clip(0).end(); await flush(); // clause 1 is refused
  assert.equal(audio.state.get().enabled, false);
  assert.deepEqual(posts.at(-1), { event: "done", id: "L", seq: 1, final: true });
  assert.equal(audio.state.get().queued, 1, "only M remains queued");
  FakeAudio.refuse = false;
  audio.enable(); await flush();
  assert.equal(FakeAudio.instances.at(-1)!.src, "/audio/M-0.wav");
});

// @spec DASH-UI-052, DASH-UI-022
test("a refused clause 0 posts final even though the line was never open on the page, so voice releases the line at once", async () => {
  const { audio, posts, utt, flush } = setup({ enabled: true });
  FakeAudio.refuse = true;
  utt("L", 0, "A", { more: true }); utt("M", 0, "B");
  await flush();
  assert.equal(audio.state.get().enabled, false);
  assert.deepEqual(posts, [{ event: "done", id: "L", seq: 0, final: true }]);
  assert.equal(audio.state.get().queued, 1);
});
