/**
 * The YouTube source's state machine against a scripted transport and a fake clock (CHAT-YT-007..068, CHAT-FORGET-002..005).
 * The REST and gRPC transports, over real sockets, are in youtube-transport.test.ts; the mapper is in youtube-map.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  apiErr, banned, CHAT, chatEnded, grpcErr, LIVE, netErr, resp, rig, settle, StreamScript, text, tombstone, VIDEO, at,
  type Item, type Rig,
} from "./youtube-helpers.js";
import { YouTubeSource } from "../src/youtube.js";

const HOUR = 3_600_000;

/** A poll-path rig whose lookup says live. */
function pollRig(over: Record<string, unknown> = {}): Rig {
  const r = rig({ transport: "poll", ...over });
  r.t.lookup_(LIVE);
  return r;
}
const withTime = (item: Item, iso: string): Item => { item.snippet.publishedAt = iso; return item; };

// ---------------------------------------------------------------- finding the chat

// @spec CHAT-YT-007
test("start looks the video up once, by the video id, and nothing else before the answer", async () => {
  const r = pollRig();
  await r.start();
  assert.deepEqual(r.t.calls.map((c) => [c.kind, c.videoId]), [["lookup", VIDEO], ["poll", undefined]]);
  await r.clock.advance(5 * HOUR);
  assert.equal(r.t.of("lookup").length, 1, "a broadcast that is live is not looked up again");
});

// @spec CHAT-YT-029
test("the source runs on a transport that has only lookup, openStream and poll", async () => {
  const r = pollRig();
  const t = r.t;
  const bare = { lookup: t.lookup.bind(t), openStream: t.openStream.bind(t), poll: t.poll.bind(t) };
  assert.deepEqual(Object.keys(bare).toSorted(), ["lookup", "openStream", "poll"]);
  const src = new YouTubeSource({ videoId: VIDEO, youtube: { api_key: "k", video: VIDEO, transport: "poll", poll_floor_ms: 1000, recheck_ms: 120000 }, transport: bare, clock: r.clock });
  await src.start({ emit() {}, emitRemoval() {}, log: r.rec.log, onState() {} } as never);
  await settle();
  assert.equal(src.state().state, "starting", "a poll is pending: the source asked the transport and waits");
  assert.equal(t.of("poll").length, 1);
  src.stop();
});

// @spec CHAT-YT-008
test("a lookup with no item stops the source: video not found", async () => {
  const r = rig({ transport: "poll" });
  r.t.lookup_(undefined);
  await r.start();
  assert.equal(r.state(), "stopped");
  assert.match(r.reason()!, /not found/);
  assert.equal(r.rec.msgs("error").length, 1, "one error names the reason");
});

// @spec CHAT-YT-009
test("an upcoming broadcast waits with its reason and is looked up again every recheck_ms", async () => {
  const r = rig({ transport: "poll", recheck_ms: 30000 });
  const upcoming = { liveBroadcastContent: "upcoming" as const, scheduledStartTime: "2026-11-24T12:00:00Z" };
  r.t.lookup_(upcoming, upcoming, LIVE);
  await r.start();
  assert.equal(r.state(), "waiting");
  assert.match(r.reason()!, /broadcast has not started/);
  await r.clock.advance(29_999);
  assert.equal(r.t.of("lookup").length, 1);
  await r.clock.advance(1);
  assert.equal(r.t.of("lookup").length, 2);
  assert.equal(r.state(), "waiting");
  await r.clock.advance(30_000);
  assert.equal(r.t.of("lookup").length, 3);
  assert.equal(r.t.of("poll").length, 1, "once live, the chat is read");
  assert.deepEqual(r.t.of("lookup").map((c) => c.at), [0, 30000, 60000]);
});

// @spec CHAT-YT-010
test("a live video with an activeLiveChatId is read through that chat id", async () => {
  const p = pollRig();
  await p.start();
  assert.equal(p.t.of("poll")[0]!.chatId, CHAT);
  const s = rig();
  s.t.lookup_(LIVE).stream_(new StreamScript().open());
  await s.start();
  assert.equal(s.t.of("stream")[0]!.chatId, CHAT);
});

// @spec CHAT-YT-011
test("a live video with no activeLiveChatId stops the source: live chat is disabled", async () => {
  const r = rig({ transport: "poll" });
  r.t.lookup_({ liveBroadcastContent: "live" });
  await r.start();
  assert.equal(r.state(), "stopped");
  assert.match(r.reason()!, /live chat is disabled/);
});

// @spec CHAT-YT-012
test("a video that is not live and has an actualEndTime stops the source: the broadcast has ended", async () => {
  const r = rig({ transport: "poll" });
  r.t.lookup_({ liveBroadcastContent: "none", actualEndTime: "2026-11-22T12:00:00Z" });
  await r.start();
  assert.equal(r.state(), "stopped");
  assert.match(r.reason()!, /broadcast has ended/);
});

// @spec CHAT-YT-013
test("a video that is not live and has no actualEndTime stops the source: not a live broadcast", async () => {
  const r = rig({ transport: "poll" });
  r.t.lookup_({ liveBroadcastContent: "none" });
  await r.start();
  assert.equal(r.state(), "stopped");
  assert.match(r.reason()!, /not a live broadcast/);
});

// @spec CHAT-YT-014
test("a stopped source makes no further request, however long it is left", async () => {
  for (const item of [undefined, { liveBroadcastContent: "live" as const }, { liveBroadcastContent: "none" as const }]) {
    const r = rig({ transport: "poll" });
    r.t.lookup_(item);
    await r.start();
    assert.equal(r.state(), "stopped");
    await r.clock.advance(48 * HOUR);
    assert.equal(r.t.calls.length, 1, "only the first lookup");
    assert.equal(r.state(), "stopped");
    assert.equal(r.clock.pending, 0, "no timer is left running");
  }
});

// ---------------------------------------------------------------- the stream

// @spec CHAT-YT-015
test("where transport is stream the source reads by opening the stream for the chat id and never polls", async () => {
  const r = rig();
  r.t.lookup_(LIVE).stream_(new StreamScript().open());
  await r.start();
  assert.equal(r.t.of("stream").length, 1);
  assert.equal(r.t.of("stream")[0]!.chatId, CHAT);
  assert.equal(r.t.of("stream")[0]!.pageToken, undefined, "the first open has no page token");
  await r.clock.advance(HOUR);
  assert.equal(r.t.of("poll").length, 0);
});

// @spec CHAT-YT-016
test("the source is reading once the response begins, not when the call is made", async () => {
  const r = rig();
  const s = new StreamScript();
  r.t.lookup_(LIVE).stream_(s);
  await r.start();
  assert.notEqual(r.state(), "reading", "the call is open but no response has begun");
  s.open();
  await settle();
  assert.equal(r.state(), "reading");
});

// @spec CHAT-YT-017
test("an open stream that sends no message keeps the source reading", async () => {
  const r = rig();
  const s = new StreamScript().open();
  r.t.lookup_(LIVE).stream_(s);
  await r.start();
  await r.clock.advance(30 * 60_000);
  assert.equal(r.state(), "reading");
  assert.equal(r.t.of("stream").length, 1, "never reopened");
  assert.equal(s.aborted, false);
});

// @spec CHAT-YT-018
test("a stream that ends or fails is reopened with the last token on a 1 s backoff that doubles to 60 s and resets when a response begins", async () => {
  const r = rig();
  const s1 = new StreamScript().open().respond(resp([text("h", 0)], { nextPageToken: "T1" })).end();
  const fail = () => grpcErr("UNAVAILABLE");
  const s9 = new StreamScript().open().end();
  r.t.lookup_(LIVE).stream_(s1, fail(), fail(), fail(), fail(), fail(), fail(), fail(), s9);
  await r.start();
  assert.equal(r.state(), "retrying");
  await r.clock.advance(999);
  assert.equal(r.t.of("stream").length, 1, "not before 1 s");
  await r.clock.advance(1);
  assert.equal(r.t.of("stream").length, 2);
  await r.clock.advance(184_000 - 1000);
  const calls = r.t.of("stream");
  assert.deepEqual(calls.map((c) => c.at), [0, 1000, 3000, 7000, 15000, 31000, 63000, 123000, 183000, 184000]);
  assert.ok(calls.slice(1).every((c) => c.pageToken === "T1"), "every reopen carries the last page token");
  assert.equal(r.t.of("poll").length, 0, "once the stream has been open there is no fallback");
});

// @spec CHAT-YT-018
test("a stream that ends while open reports retrying until the reopened stream begins, then reading again", async () => {
  const r = rig();
  const s2 = new StreamScript();
  r.t.lookup_(LIVE).stream_(new StreamScript().open().end(), s2);
  await r.start();
  assert.equal(r.state(), "retrying");
  await r.clock.advance(1000);
  assert.equal(r.state(), "retrying", "the reopened call has not begun a response");
  s2.open();
  await settle();
  assert.equal(r.state(), "reading");
});

// @spec CHAT-YT-019
test("five consecutive attempts to open the stream with no response fall back to polling, after 1, 2, 4 and 8 s", async () => {
  const r = rig();
  r.t.lookup_(LIVE).stream_(grpcErr("UNAVAILABLE"), new StreamScript().end(), grpcErr("INTERNAL"), netErr(), grpcErr("DEADLINE_EXCEEDED"));
  r.t.poll_(resp([]));
  await r.start();
  assert.equal(r.state(), "retrying");
  await r.clock.advance(15_000);
  assert.deepEqual(r.t.of("stream").map((c) => c.at), [0, 1000, 3000, 7000, 15000]);
  assert.equal(r.t.of("poll").length, 1, "the fifth failure switches to polling");
  assert.equal(r.t.of("poll")[0]!.pageToken, undefined, "no response ever came, so there is no token");
  assert.equal(r.state(), "reading");
});

// @spec CHAT-YT-019, CHAT-YT-045
test("a stream open that fails with NOT_FOUND does not count toward the five attempts", async () => {
  const r = rig();
  r.t.lookup_(LIVE, LIVE, LIVE, LIVE, LIVE, LIVE, LIVE, LIVE);
  r.t.stream_(...Array.from({ length: 8 }, () => grpcErr("NOT_FOUND")));
  await r.start();
  await r.clock.advance(HOUR);
  assert.ok(r.t.of("stream").length >= 6, "the stream is retried past five failures");
  assert.equal(r.t.of("poll").length, 0);
});

// @spec CHAT-YT-020
test("UNIMPLEMENTED or PERMISSION_DENIED when opening the stream falls back to polling at once and logs a warning naming it", async () => {
  for (const status of ["UNIMPLEMENTED", "PERMISSION_DENIED"]) {
    const r = rig();
    r.t.lookup_(LIVE).stream_(grpcErr(status)).poll_(resp([]));
    await r.start();
    assert.equal(r.t.of("stream").length, 1, status);
    assert.equal(r.t.of("poll").length, 1, status);
    const warned = r.rec.lines.filter((l) => l.level === "warn").map((l) => JSON.stringify(l));
    assert.ok(warned.some((w) => w.includes(status)), `${status} is named in a warning`);
  }
});

// @spec CHAT-YT-021
test("once the stream has been open the source never falls back to polling however often it fails", async () => {
  const r = rig();
  r.t.lookup_(LIVE).stream_(new StreamScript().open().end(), ...Array.from({ length: 12 }, () => grpcErr("UNAVAILABLE")));
  await r.start();
  await r.clock.advance(20 * 60_000);
  assert.ok(r.t.of("stream").length >= 8);
  assert.equal(r.t.of("poll").length, 0);
});

// @spec CHAT-YT-022
test("PERMISSION_DENIED after the stream has been open stops the source: the chat refuses the API key", async () => {
  const r = rig();
  r.t.lookup_(LIVE).stream_(new StreamScript().open().end(), grpcErr("PERMISSION_DENIED"));
  await r.start();
  await r.clock.advance(1000);
  assert.equal(r.state(), "stopped");
  assert.match(r.reason()!, /refuses the API key/);
  assert.equal(r.t.of("poll").length, 0);
});

// @spec CHAT-YT-023
test("after the switch to polling the source never returns to the stream", async () => {
  const r = rig();
  r.t.lookup_(LIVE).stream_(grpcErr("UNIMPLEMENTED"));
  r.t.pollForever = () => resp([]);
  await r.start();
  await r.clock.advance(10 * 60_000);
  assert.equal(r.t.of("stream").length, 1);
  assert.ok(r.t.of("poll").length > 10);
});

// ---------------------------------------------------------------- polling

// @spec CHAT-YT-026
test("where transport is poll the source polls and never opens a stream", async () => {
  const r = pollRig();
  r.t.pollForever = () => resp([]);
  await r.start();
  await r.clock.advance(60_000);
  assert.equal(r.t.of("stream").length, 0);
  assert.ok(r.t.of("poll").length > 5);
  assert.equal(r.t.of("poll")[0]!.pageToken, undefined, "the first poll has no token");
  assert.equal(r.t.of("poll")[1]!.pageToken, "tok", "later polls carry the last nextPageToken");
});

// @spec CHAT-YT-027
test("the wait between polls is the larger of the server's pollingIntervalMillis and poll_floor_ms", async () => {
  const slow = pollRig({ poll_floor_ms: 12000 });
  slow.t.poll_(resp([], { pollingIntervalMillis: 20000 }), resp([], { pollingIntervalMillis: 500 }), resp([]));
  await slow.start();
  await slow.clock.advance(19_999);
  assert.equal(slow.t.of("poll").length, 1, "the server's interval is longer than the floor");
  await slow.clock.advance(1);
  assert.equal(slow.t.of("poll").length, 2);
  await slow.clock.advance(11_999);
  assert.equal(slow.t.of("poll").length, 2, "the floor is longer than the server's 500 ms");
  await slow.clock.advance(1);
  assert.equal(slow.t.of("poll").length, 3);
});

// @spec CHAT-YT-028
test("each poll response makes the source reading", async () => {
  const r = pollRig();
  let release!: () => void;
  r.t.poll_(() => new Promise((res) => { release = () => res(resp([])); }));
  await r.start();
  assert.notEqual(r.state(), "reading", "the poll has not answered");
  release();
  await settle();
  assert.equal(r.state(), "reading");
});

// ---------------------------------------------------------------- quota

// @spec CHAT-YT-030
test("the tally counts 1 unit per lookup and 5 per poll; lines at the first call, at a state change and every ten minutes", async () => {
  const r = pollRig();
  r.t.poll_(resp([]), resp([]));
  await r.start();
  await r.clock.advance(1000);
  const before = r.infos("youtube quota tally").length;
  assert.equal(before, 2, "one line at the first poll call, one at the change to reading");
  assert.deepEqual(r.infos("youtube quota tally").at(-1), { units: 6, batches: 0 }, "the second poll is spent but not yet logged: no state change");
  await r.clock.advance(10 * 60_000);
  assert.equal(r.infos("youtube quota tally").length, before + 1, "one more line after ten minutes, and none for the poll that hangs");
  assert.deepEqual(r.infos("youtube quota tally").at(-1), { units: 16, batches: 0 }, "lookup and three polls");
});

// @spec CHAT-YT-030
test("the tally counts 5 units per stream open and the pushed batches separately from units", async () => {
  const r = rig();
  const s = new StreamScript().open().respond(resp([text("h", 0)])).respond(resp([text("a", 1)])).respond(resp([]));
  r.t.lookup_(LIVE).stream_(s);
  await r.start();
  await r.clock.advance(10 * 60_000);
  assert.deepEqual(r.infos("youtube quota tally").at(-1), { units: 6, batches: 3 });
});

// @spec CHAT-YT-030
test("the tally is logged at every state change", async () => {
  const r = pollRig();
  r.t.poll_(resp([]), apiErr(500));
  await r.start();
  const afterReading = r.infos("youtube quota tally").length;
  await r.clock.advance(1000);
  assert.equal(r.state(), "retrying");
  assert.ok(r.infos("youtube quota tally").length > afterReading);
});

// @spec CHAT-YT-031
test("the tally is in memory only: a new source starts at zero and takes no action at any total", async () => {
  const r = pollRig();
  r.t.pollForever = () => resp([]);
  await r.start();
  await r.clock.advance(30 * 60_000 + 1000);
  const last = r.infos("youtube quota tally").at(-1) as { units: number };
  assert.ok(last.units > 9_000, `the tally at the half hour line: ${last.units}`);
  assert.equal(r.state(), "reading", "no action on the total");
  assert.ok(r.t.of("poll").length > 1800, "polling goes on past the total, unchanged");

  const fresh = pollRig();
  await fresh.start();
  assert.deepEqual(fresh.infos("youtube quota tally").at(-1), { units: 6, batches: 0 }, "a new source starts at zero");
  fresh.src.stop();

  const dir = join(fileURLToPath(new URL("../src/", import.meta.url)));
  const files = readdirSync(dir).filter((f) => f.startsWith("youtube") && f.endsWith(".ts"));
  assert.ok(files.includes("youtube.ts"));
  for (const f of files) assert.doesNotMatch(readFileSync(join(dir, f), "utf8"), /writeFile|appendFile|createWriteStream|writeSync|mkdir/, `${f} writes nothing to disk`);
});

// @spec CHAT-YT-032
test("403 quotaExceeded makes the source retrying with the reason quota and an hourly lookup until one succeeds", async () => {
  const r = pollRig();
  r.t.poll_(resp([text("h", 0)], { nextPageToken: "tokA" }), apiErr(403, "quotaExceeded"));
  r.t.lookup_(apiErr(403, "quotaExceeded"), LIVE);
  await r.start();
  await r.clock.advance(1000);
  assert.equal(r.state(), "retrying");
  assert.equal(r.reason(), "quota");
  await r.clock.advance(HOUR - 1);
  assert.equal(r.t.of("lookup").length, 1);
  await r.clock.advance(1);
  assert.equal(r.t.of("lookup").length, 2);
  assert.equal(r.state(), "retrying", "that lookup failed with quota too");
  assert.equal(r.reason(), "quota");
  await r.clock.advance(HOUR);
  assert.equal(r.t.of("lookup").length, 3);
  const times = r.t.of("lookup").map((c) => c.at);
  assert.equal(times[1]! - 1000, HOUR, "an hour after the quota failure");
  assert.equal(times[2]! - times[1]!, HOUR, "and an hour after that");
});

// @spec CHAT-YT-033
test("after quota the source resumes from its last page token", async () => {
  const r = pollRig();
  r.t.poll_(resp([text("h", 0)], { nextPageToken: "tokA" }), apiErr(403, "quotaExceeded"), resp([text("n", 20)], { nextPageToken: "tokB" }));
  r.t.lookup_(LIVE);
  await r.start();
  await r.clock.advance(1000 + HOUR + 5000);
  const polls = r.t.of("poll");
  // The resume call (the third poll) carries the token; later polls carry what their responses returned (CHAT-YT-027).
  assert.equal(polls[2]!.pageToken, "tokA", "the resume call carries the token");
  assert.deepEqual(r.texts(), ["n"]);
});

// @spec CHAT-YT-033
test("a token rejected on resume after quota is dropped and newest is the baseline", async () => {
  const r = pollRig();
  r.t.poll_(
    resp([text("h", 0)], { nextPageToken: "tokA" }), apiErr(403, "quotaExceeded"), apiErr(400, "pageTokenInvalid"),
    resp([text("h", 0), text("n", 10)], { nextPageToken: "tokC" }),
  );
  r.t.lookup_(LIVE);
  await r.start();
  await r.clock.advance(1000 + HOUR + 10_000);
  const polls = r.t.of("poll");
  assert.equal(polls[2]!.pageToken, "tokA", "the resume call carries the rejected token");
  assert.equal(polls[3]!.pageToken, undefined, "the next call polls without a token");
  assert.deepEqual(r.texts(), ["n"], "history is dropped by newest and by the seen ids");
});

// @spec CHAT-YT-062
test("quota exhaustion before the stream ever opened is not one of the five attempts", async () => {
  const r = rig();
  r.t.lookup_(LIVE, LIVE);
  const fail = () => grpcErr("UNAVAILABLE");
  r.t.stream_(grpcErr("RESOURCE_EXHAUSTED"), fail(), fail(), fail(), fail(), fail());
  r.t.poll_(resp([]));
  await r.start();
  assert.equal(r.state(), "retrying");
  assert.equal(r.reason(), "quota");
  await r.clock.advance(HOUR + 7000);
  assert.equal(r.t.of("stream").length, 5, "the quota attempt plus four failures");
  assert.equal(r.t.of("poll").length, 0, "four counted attempts are not five");
  await r.clock.advance(8000);
  assert.equal(r.t.of("stream").length, 6);
  assert.equal(r.t.of("poll").length, 1, "the fifth counted attempt switches to polling");
});

// ---------------------------------------------------------------- history and duplicates

/** A poll-path rig that has taken the history response and is ready for the next poll. */
async function afterHistory(history: Item[], more: ReturnType<typeof resp>[]): Promise<Rig> {
  const r = pollRig();
  r.t.poll_(resp(history), ...more);
  await r.start();
  assert.deepEqual(r.sent, [], "the history response publishes nothing");
  return r;
}
async function next(r: Rig) { await r.clock.advance(1000); }

// @spec CHAT-YT-034
test("the first response without a token publishes nothing and records every id in it", async () => {
  const r = await afterHistory([text("h1", 0), text("h2", 1)], [resp([text("h1", 2), text("n1", 5)])]);
  await next(r);
  assert.deepEqual(r.texts(), ["n1"], "h1 came again with a later time, and is dropped by its id");
});

// @spec CHAT-YT-035
test("a later message is published only when its id is unseen and its publishedAt is later than newest", async () => {
  const r = await afterHistory([text("h", 10)], [resp([text("old", 5), text("same", 10), text("new", 11)])]);
  await next(r);
  assert.deepEqual(r.texts(), ["new"], "older and equal times are dropped");
});

// @spec CHAT-YT-035
test("a later message with no publishedAt is published once its id is unseen, after the baseline exists", async () => {
  const r = await afterHistory([text("h", 10)], [resp([text("h", undefined), text("bare", undefined), text("new", 11)])]);
  await next(r);
  assert.deepEqual(r.texts(), ["bare", "new"], "the seen id h is dropped; a message with no publishedAt is published");
});

// @spec CHAT-YT-036
test("a first response with no publishedAt is dropped and every unseen message of later responses is published", async () => {
  const r = await afterHistory([text("h1", undefined), text("h2", undefined)], [resp([text("h1", undefined), text("n1", -1000), text("n2", undefined)])]);
  await next(r);
  assert.deepEqual(r.texts(), ["n1", "n2"]);
});

// @spec CHAT-YT-037
test("publishedAt values are compared with each other and never with the host's clock", async () => {
  const past = await afterHistory([withTime(text("h", 0), "2001-01-01T00:00:00Z")], [resp([withTime(text("a", 0), "2001-01-01T00:00:05Z"), withTime(text("b", 0), "2000-12-31T23:59:00Z")])]);
  await next(past);
  assert.deepEqual(past.texts(), ["a"], "a time 25 years behind the host is later than newest");
  const future = await afterHistory([withTime(text("h", 0), "2999-01-01T00:00:00Z")], [resp([withTime(text("a", 0), "2999-01-01T00:00:05Z"), withTime(text("b", 0), "2026-11-23T12:00:00Z")])]);
  await next(future);
  assert.deepEqual(future.texts(), ["a"], "a time centuries ahead of the host is not an error");
});

// @spec CHAT-YT-038
test("the last 2,000 message ids are remembered, and a message with a remembered id is dropped", async () => {
  const batch = Array.from({ length: 2001 }, (_, i) => text(`b${i}`, 1));
  const r = await afterHistory([text("h", 0)], [resp(batch), resp([text("b2000", 5), text("b1", 5), text("b0", 5)])]);
  await next(r);
  assert.equal(r.sent.length, 2001);
  await next(r);
  assert.deepEqual(r.texts().slice(2001), ["b0"], "b1 and b2000 are within the last 2,000 ids; b0 was evicted");
});

// @spec CHAT-YT-039
test("a restarted source starts with no newest and no recorded ids", async () => {
  const first = await afterHistory([text("h", 0)], [resp([text("x", 5)])]);
  await next(first);
  assert.deepEqual(first.texts(), ["x"]);
  const second = pollRig();
  second.t.poll_(resp([]), resp([text("x", 5)]));
  await second.start();
  await next(second);
  assert.deepEqual(second.texts(), ["x"], "x is not remembered across a restart, and no newest drops it");
});

// @spec CHAT-YT-060
test("newest is the latest publishedAt in a response, not the last, and a response with none leaves it unchanged", async () => {
  const r = await afterHistory([text("h", 0)], [
    resp([text("a", 5), text("b", 9), text("c", 7)]), resp([]), resp([text("d", 8), text("e", 10)]),
  ]);
  await next(r);
  assert.deepEqual(r.texts(), ["a", "b", "c"]);
  await next(r);
  await next(r);
  assert.deepEqual(r.texts(), ["a", "b", "c", "e"], "d is earlier than 9, which survived the empty response");
});

// @spec CHAT-YT-061
test("a first response with no message means there is no history: later messages are published and newest is set by the first that has any", async () => {
  const r = pollRig();
  r.t.poll_(resp([]), resp([text("m1", 5)]), resp([text("m2", 4), text("m3", 6)]));
  await r.start();
  await next(r);
  assert.deepEqual(r.texts(), ["m1"], "the first messages of a chat with no history are not dropped");
  await next(r);
  assert.deepEqual(r.texts(), ["m1", "m3"], "m2 is earlier than the newest set by m1");
});

// ---------------------------------------------------------------- errors

// @spec CHAT-YT-040
test("403 forbidden on the video lookup stops the source: the API key was rejected", async () => {
  const r = rig({ transport: "poll" });
  r.t.lookup_(apiErr(403, "forbidden"));
  await r.start();
  assert.equal(r.state(), "stopped");
  assert.match(r.reason()!, /API key was rejected/);
});

// @spec CHAT-YT-041
test("403 forbidden on a poll stops the source: the chat refuses the API key", async () => {
  const r = pollRig();
  r.t.poll_(apiErr(403, "forbidden"));
  await r.start();
  assert.equal(r.state(), "stopped");
  assert.match(r.reason()!, /refuses the API key/);
});

// @spec CHAT-YT-042
test("401 or UNAUTHENTICATED stops the source: authentication failed", async () => {
  const onLookup = rig({ transport: "poll" });
  onLookup.t.lookup_(apiErr(401));
  await onLookup.start();
  assert.equal(onLookup.state(), "stopped");
  assert.match(onLookup.reason()!, /authentication failed/);
  const onPoll = pollRig();
  onPoll.t.poll_(apiErr(401));
  await onPoll.start();
  assert.match(onPoll.reason()!, /authentication failed/);
  const onStream = rig();
  onStream.t.lookup_(LIVE).stream_(grpcErr("UNAUTHENTICATED"));
  await onStream.start();
  assert.equal(onStream.state(), "stopped");
  assert.match(onStream.reason()!, /authentication failed/);
  assert.equal(onStream.t.of("poll").length, 0, "no fallback");
});

// @spec CHAT-YT-043
test("a 400 or 403 that no other rule names stops the source with the API's reason", async () => {
  const onPoll = pollRig();
  onPoll.t.poll_(apiErr(403, "accessNotConfigured"));
  await onPoll.start();
  assert.equal(onPoll.state(), "stopped");
  assert.match(onPoll.reason()!, /accessNotConfigured/);
  const onLookup = rig({ transport: "poll" });
  onLookup.t.lookup_(apiErr(400, "badRequest"));
  await onLookup.start();
  assert.equal(onLookup.state(), "stopped");
  assert.match(onLookup.reason()!, /badRequest/);
  await onLookup.clock.advance(HOUR);
  assert.equal(onLookup.t.calls.length, 1, "until restart");
});

// @spec CHAT-YT-044
test("liveChatDisabled, liveChatEnded and FAILED_PRECONDITION trigger a lookup 1 s later and act on its result", async () => {
  const ended = { liveBroadcastContent: "none" as const, actualEndTime: "2026-11-23T12:30:00Z" };
  for (const make of [() => apiErr(403, "liveChatDisabled"), () => apiErr(403, "liveChatEnded")]) {
    const r = pollRig();
    r.t.poll_(make()).lookup_(ended);
    await r.start();
    await r.clock.advance(999);
    assert.equal(r.t.of("lookup").length, 1, "paced by the backoff");
    await r.clock.advance(1);
    assert.equal(r.t.of("lookup").length, 2);
    assert.equal(r.state(), "stopped");
    assert.match(r.reason()!, /broadcast has ended/);
  }
  const stream = rig();
  stream.t.lookup_(LIVE, { liveBroadcastContent: "live" }).stream_(grpcErr("FAILED_PRECONDITION"));
  await stream.start();
  await stream.clock.advance(1000);
  assert.equal(stream.state(), "stopped");
  assert.match(stream.reason()!, /live chat is disabled/);
  const live = pollRig();
  live.t.poll_(apiErr(403, "liveChatEnded"), resp([])).lookup_(LIVE);
  await live.start();
  await live.clock.advance(5000);
  assert.equal(live.state(), "reading", "a lookup that says live goes back to reading");
});

// @spec CHAT-YT-045
test("404 liveChatNotFound or NOT_FOUND looks the video up again: stopped when it has ended, otherwise retrying", async () => {
  const ended = { liveBroadcastContent: "none" as const, actualEndTime: "2026-11-23T12:30:00Z" };
  const a = pollRig();
  a.t.poll_(apiErr(404, "liveChatNotFound")).lookup_(ended);
  await a.start();
  await a.clock.advance(1000);
  assert.equal(a.state(), "stopped");
  assert.match(a.reason()!, /broadcast has ended/);
  const b = rig();
  b.t.lookup_(LIVE, ended).stream_(grpcErr("NOT_FOUND"));
  await b.start();
  await b.clock.advance(1000);
  assert.equal(b.state(), "stopped");
  const c = pollRig();
  c.t.poll_(apiErr(404, "liveChatNotFound"), resp([])).lookup_(LIVE);
  await c.start();
  await c.clock.advance(1000);
  assert.equal(c.state(), "retrying", "the broadcast is still live: retrying, not stopped");
  await c.clock.advance(10_000);
  assert.equal(c.state(), "reading");
});

// @spec CHAT-YT-046
test("a rejected page token is discarded and the source reads without one, with newest as the baseline", async () => {
  const r = await afterHistory([text("h", 0)], [apiErr(400, "pageTokenInvalid"), resp([text("h", 0), text("n", 3)])]);
  await r.clock.advance(5000);
  const polls = r.t.of("poll");
  assert.equal(polls[1]!.pageToken, "tok");
  assert.equal(polls[2]!.pageToken, undefined);
  assert.deepEqual(r.texts(), ["n"]);
  // A failed call that carried no token is retrying (CHAT-YT-046): the reopen carries T1; a call that carried T1 and is rejected drops it.
  const stream = rig();
  stream.t.lookup_(LIVE).stream_(
    new StreamScript().open().respond(resp([text("h", 0)], { nextPageToken: "T1" })).fail(grpcErr("INVALID_ARGUMENT")),
    grpcErr("INVALID_ARGUMENT"),
    new StreamScript().open(),
  );
  await stream.start();
  await stream.clock.advance(1000);
  assert.equal(stream.t.of("stream")[1]!.pageToken, "T1", "the call that carried no token is retrying: the next call carries T1");
  assert.equal(stream.t.of("stream")[2]!.pageToken, undefined, "the rejected T1 is dropped and the reopen carries no token");
});

// @spec CHAT-YT-046
test("a page-token rejection on a call that carried no token makes the source retrying", async () => {
  const r = pollRig();
  r.t.poll_(apiErr(400, "pageTokenInvalid"), resp([]));
  await r.start();
  assert.equal(r.state(), "retrying");
  await r.clock.advance(10_000);
  assert.equal(r.state(), "reading");
});

// @spec CHAT-YT-047
test("403 rateLimitExceeded on a poll doubles the next wait once, then the normal rule returns", async () => {
  const r = pollRig();
  r.t.poll_(resp([]), apiErr(403, "rateLimitExceeded"), resp([]), resp([]));
  await r.start();
  await r.clock.advance(4000);
  assert.deepEqual(r.t.of("poll").map((c) => c.at), [0, 1000, 3000, 4000]);
  assert.notEqual(r.state(), "stopped");
});

// @spec CHAT-YT-048
test("RESOURCE_EXHAUSTED is quota exhaustion: retrying with the reason quota and an hourly lookup", async () => {
  const r = rig();
  r.t.lookup_(LIVE, LIVE).stream_(grpcErr("RESOURCE_EXHAUSTED"), new StreamScript().open());
  await r.start();
  assert.equal(r.state(), "retrying");
  assert.equal(r.reason(), "quota");
  await r.clock.advance(HOUR - 1);
  assert.equal(r.t.of("lookup").length, 1);
  await r.clock.advance(1);
  assert.equal(r.t.of("lookup").length, 2);
  assert.equal(r.t.of("stream").length, 2, "reading resumes once the lookup succeeds");
  assert.equal(r.state(), "reading");
});

// @spec CHAT-YT-049
test("a network failure or 5xx on the lookup is retrying on a 1 s backoff that doubles", async () => {
  const r = rig({ transport: "poll" });
  r.t.lookup_(netErr(), apiErr(500), apiErr(503), LIVE);
  await r.start();
  assert.equal(r.state(), "retrying");
  await r.clock.advance(7000);
  assert.deepEqual(r.t.of("lookup").map((c) => c.at), [0, 1000, 3000, 7000]);
  assert.equal(r.t.of("poll").length, 1);
});

// @spec CHAT-YT-049
test("poll failures retry on the capped backoff, which resets when a call succeeds", async () => {
  const r = pollRig();
  r.t.poll_(resp([]), netErr(), apiErr(500), resp([]), apiErr(503), resp([]));
  await r.start();
  await r.clock.advance(6000);
  assert.deepEqual(r.t.of("poll").map((c) => c.at), [0, 1000, 2000, 4000, 5000, 6000]);
});

// @spec CHAT-YT-049
test("a successful live lookup does not reset the backoff: the next poll failure waits the grown delay", async () => {
  const r = rig({ transport: "poll" });
  r.t.lookup_(apiErr(500), apiErr(500), LIVE);
  r.t.poll_(apiErr(500), resp([]));
  await r.start();
  await r.clock.advance(3000);
  assert.deepEqual(r.t.of("lookup").map((c) => c.at), [0, 1000, 3000], "lookups paced 1 s then 2 s");
  assert.deepEqual(r.t.of("poll").map((c) => c.at), [3000], "the live lookup starts the poll at once");
  await r.clock.advance(4000);
  assert.deepEqual(r.t.of("poll").map((c) => c.at), [3000, 7000], "the poll failure waits 4 s, not 1 s: the lookup did not reset the backoff");
});

// @spec CHAT-YT-049
test("the backoff is capped at 60 s", async () => {
  const r = rig({ transport: "poll" });
  r.t.lookup_(...Array.from({ length: 10 }, () => apiErr(502)), LIVE);
  await r.start();
  await r.clock.advance(1000 + 2000 + 4000 + 8000 + 16000 + 32000 + 60000 + 60000 + 60000 + 60000);
  const gaps = r.t.of("lookup").map((c, i, a) => c.at - (a[i - 1]?.at ?? 0)).slice(1);
  assert.deepEqual(gaps, [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000, 60000]);
});

// @spec CHAT-YT-050
test("offlineAt on a response, or a chatEndedEvent, stops the source: the broadcast has ended", async () => {
  const a = pollRig();
  a.t.poll_(resp([text("h", 0)], { offlineAt: "2026-11-23T13:00:00Z" }));
  await a.start();
  assert.equal(a.state(), "stopped");
  assert.match(a.reason()!, /broadcast has ended/);
  await a.clock.advance(HOUR);
  assert.equal(a.t.of("poll").length, 1, "no further request");
  const b = await afterHistory([text("h", 0)], [resp([chatEnded()])]);
  await next(b);
  assert.equal(b.state(), "stopped");
  assert.match(b.reason()!, /broadcast has ended/);
  const c = rig();
  c.t.lookup_(LIVE).stream_(new StreamScript().open().respond(resp([], { offlineAt: "2026-11-23T13:00:00Z" })));
  await c.start();
  assert.equal(c.state(), "stopped");
});

// @spec CHAT-YT-056
test("sponsor-only mode start and end are logged at info and publish nothing", async () => {
  const mk = (id: string, type: string): Item => ({ id, snippet: { type, publishedAt: at(5) }, authorDetails: { channelId: "UC1" } });
  const r = await afterHistory([text("h", 0)], [resp([mk("s1", "sponsorOnlyModeStartedEvent"), mk("s2", "sponsorOnlyModeEndedEvent")])]);
  await next(r);
  assert.equal(r.sent.length, 0);
  assert.equal(r.removals.length, 0);
  assert.ok(r.rec.lines.some((l) => l.level === "info" && /sponsor/i.test(`${l.msg} ${JSON.stringify(l.obj)}`)));
});

// @spec CHAT-YT-068
test("lookups made in response to a failing chat are paced by the capped backoff and get no faster", async () => {
  const r = pollRig();
  r.t.poll_(...Array.from({ length: 6 }, () => apiErr(403, "liveChatEnded")));
  r.t.lookup_(...Array.from({ length: 8 }, () => LIVE));
  await r.start();
  await r.clock.advance(200_000);
  const times = r.t.of("lookup").map((c) => c.at);
  assert.ok(times.length >= 6, `${times.length} lookups`);
  const gaps = times.slice(1).map((t, i) => t - times[i]!);
  [1000, 2000, 4000, 8000, 16000].forEach((min, i) => assert.ok(gaps[i]! >= min, `gap ${i} is ${gaps[i]}, at least ${min}`));
});

// ---------------------------------------------------------------- after a break

/** History, a break (a 500, or quota), then the response `resumed` read from the token. */
async function afterBreak(resumed: Item[], how: "error" | "quota"): Promise<Rig> {
  const r = pollRig();
  r.t.poll_(resp([text("h", 0)], { nextPageToken: "tokA" }), how === "error" ? apiErr(500) : apiErr(403, "quotaExceeded"), resp(resumed));
  if (how === "quota") r.t.lookup_(LIVE);
  await r.start();
  await r.clock.advance(how === "error" ? 5000 : HOUR + 5000);
  assert.equal(r.t.of("poll")[2]!.pageToken, "tokA", "the resume call carries the token");
  return r;
}

// @spec CHAT-YT-063
test("after a break a message more than 60 s older than the response's newest is not published", async () => {
  for (const how of ["error", "quota"] as const) {
    const r = await afterBreak([text("a", 10), text("e", 39), text("d", 40), text("c", 80), text("b", 100)], how);
    assert.deepEqual(r.texts(), ["d", "c", "b"], `${how}: exactly 60 s earlier is kept, 61 s is not`);
  }
});

// @spec CHAT-YT-063
test("the 60 s rule also holds when a stream resumes from its token", async () => {
  const r = rig();
  const s2 = new StreamScript().open().respond(resp([text("a", 10), text("b", 100)]));
  r.t.lookup_(LIVE).stream_(new StreamScript().open().respond(resp([text("h", 0)], { nextPageToken: "T1" })).end(), s2);
  await r.start();
  await r.clock.advance(1000);
  assert.equal(r.t.of("stream")[1]!.pageToken, "T1");
  assert.deepEqual(r.texts(), ["b"]);
});

// @spec CHAT-YT-064
test("after a break a response with no publishedAt is dropped whole", async () => {
  const r = await afterBreak([text("x", undefined), text("y", undefined)], "error");
  assert.deepEqual(r.texts(), []);
});

// @spec CHAT-YT-065
test("while reading without a break the 60 s rule applies to no response", async () => {
  const r = await afterHistory([text("h", 0)], [resp([text("a", 10), text("b", 200)])]);
  await next(r);
  assert.deepEqual(r.texts(), ["a", "b"]);
});

// ---------------------------------------------------------------- removals

// @spec CHAT-YT-066, CHAT-FORGET-002
test("a tombstone after the first response is reported once as a message removal, and never twice", async () => {
  const r = await afterHistory([text("h", 0)], [resp([tombstone("t1", "m5", 5)]), resp([tombstone("t1", "m5", 5)])]);
  await next(r);
  assert.deepEqual(r.removals, [{ scope: "message", messageId: "m5" }]);
  await next(r);
  assert.equal(r.removals.length, 1, "the same marker again is not reported");
});

// @spec CHAT-YT-066
test("a marker is reported once across a stream reopen as well", async () => {
  const r = rig();
  r.t.lookup_(LIVE).stream_(
    new StreamScript().open().respond(resp([text("h", 0)], { nextPageToken: "T1" })).respond(resp([tombstone("t1", "m5", 5)])).end(),
    new StreamScript().open().respond(resp([tombstone("t1", "m5", 5)])),
  );
  await r.start();
  await r.clock.advance(1000);
  assert.equal(r.removals.length, 1);
});

// @spec CHAT-FORGET-003
test("a userBannedEvent is reported as a user removal: banned for a permanent ban, timeout for a temporary one", async () => {
  const r = await afterHistory([text("h", 0)], [resp([banned("b1", "UCone", "permanent", 5), banned("b2", "UCtwo", "temporary", 6)])]);
  await next(r);
  assert.deepEqual(r.removals, [{ scope: "user", userId: "UCone", reason: "banned" }, { scope: "user", userId: "UCtwo", reason: "timeout" }]);
});

// @spec CHAT-FORGET-004
test("a tombstone or userBannedEvent with no usable id reports no removal and logs a warning", async () => {
  const r = await afterHistory([text("h", 0)], [resp([tombstone("t1", undefined, 5), banned("b1", undefined, "permanent", 6)])]);
  await next(r);
  assert.deepEqual(r.removals, []);
  assert.ok(r.rec.msgs("warn").length >= 2, "one warning for each");
});

// @spec CHAT-FORGET-005
test("a tombstone or userBannedEvent in the first response is not reported", async () => {
  const r = pollRig();
  r.t.poll_(resp([text("h", 0), tombstone("t1", "m1", 1), banned("b1", "UCone", "permanent", 2)]), resp([text("n", 5)]));
  await r.start();
  assert.deepEqual(r.removals, []);
  assert.deepEqual(r.sent, []);
  await next(r);
  assert.deepEqual(r.texts(), ["n"]);
  assert.deepEqual(r.removals, []);
});

// @spec CHAT-YT-067
test("a message removal and the message it covers in one response are published as neither; a ban is still published", async () => {
  const r = await afterHistory([text("h", 0)], [
    resp([text("m5", 5), text("m7", 5), tombstone("t1", "m5", 6)]),
    resp([tombstone("t2", "m8", 7), text("m8", 7)]),
    resp([text("u1", 8, "u1", { channelId: "UCbad" }), text("u2", 8), banned("b1", "UCbad", "permanent", 9)]),
  ]);
  await next(r);
  assert.deepEqual(r.texts(), ["m7"], "m5 is not published");
  assert.deepEqual(r.removals, [], "and neither is its removal");
  await next(r);
  assert.deepEqual(r.texts(), ["m7"], "a marker before its message covers it too");
  assert.deepEqual(r.removals, []);
  await next(r);
  assert.deepEqual(r.texts(), ["m7", "u2"], "a ban suppresses its author's messages in the response");
  assert.deepEqual(r.removals, [{ scope: "user", userId: "UCbad", reason: "banned" }], "and the ban itself is still published (M1)");
});

// @spec CHAT-YT-067, CHAT-YT-066
test("a marker that covers a message published by an earlier response is reported", async () => {
  const r = await afterHistory([text("h", 0)], [resp([text("m5", 5)]), resp([tombstone("t1", "m5", 6)])]);
  await next(r);
  assert.deepEqual(r.texts(), ["m5"]);
  await next(r);
  assert.deepEqual(r.removals, [{ scope: "message", messageId: "m5" }]);
});

// ---------------------------------------------------------------- stop

// @spec CHAT-SRC-005
test("stop aborts the in-flight poll and cancels every timer", async () => {
  const r = pollRig();
  r.t.poll_(resp([text("h", 0)]));
  await r.start();
  assert.ok(r.clock.pending > 0, "a wait and the tally timer are scheduled");
  r.src.stop();
  await settle();
  assert.equal(r.clock.pending, 0);
  await r.clock.advance(HOUR);
  assert.equal(r.t.of("poll").length, 1);
  const inflight = pollRig();
  inflight.t.poll_(() => new Promise(() => {}));
  await inflight.start();
  inflight.src.stop();
  assert.equal(inflight.t.of("poll")[0]!.signal?.aborted, true, "the signal the transport was given is aborted");
});

// @spec CHAT-SRC-005
test("stop aborts the open stream and the lookup in flight", async () => {
  const s = new StreamScript().open();
  const r = rig();
  r.t.lookup_(LIVE).stream_(s);
  await r.start();
  r.src.stop();
  await settle();
  assert.equal(s.aborted, true);
  assert.equal(r.clock.pending, 0);
  const slow = rig();
  await slow.start();
  slow.src.stop();
  assert.equal(slow.t.of("lookup")[0]!.signal?.aborted, true);
});

// @spec CHAT-SRC-006
test("after stop returns the source publishes no message and no removal, even for a response already on its way", async () => {
  const r = pollRig();
  let release!: () => void;
  r.t.poll_(resp([text("h", 0)]), () => new Promise((res) => { release = () => res(resp([text("late", 5), tombstone("t1", "m1", 6)])); }));
  await r.start();
  await r.clock.advance(1000);
  r.src.stop();
  release();
  await settle();
  assert.deepEqual(r.sent, []);
  assert.deepEqual(r.removals, []);
});

// @spec CHAT-YT-001
test("the source makes no call other than lookup, openStream and poll: nothing sends a line, a ban or a timeout", async () => {
  const r = rig();
  r.t.lookup_(LIVE).stream_(new StreamScript().open().respond(resp([text("h", 0)])).respond(resp([banned("b1", "UCone", "permanent", 5), tombstone("t1", "m1", 6)])));
  await r.start();
  await r.clock.advance(HOUR);
  assert.deepEqual([...new Set(r.t.calls.map((c) => c.kind))].toSorted(), ["lookup", "stream"]);
});

// ---------------------------------------------------------------- stream path: backoff, quota token, close

// @spec CHAT-YT-021
test("once the stream has opened, five clean empty closes still never fall back to polling", async () => {
  const r = rig();
  r.t.lookup_(LIVE).stream_(new StreamScript().open().end(), ...Array.from({ length: 6 }, () => new StreamScript().end()));
  r.t.pollForever = () => resp([]);
  await r.start();
  await r.clock.advance(10 * 60_000);
  assert.ok(r.t.of("stream").length >= 7, `the stream keeps being reopened: ${r.t.of("stream").length}`);
  assert.equal(r.t.of("poll").length, 0, "no poll, however many clean empty closes");
});

// @spec CHAT-YT-044
test("a stream failure with liveChat disabled or FAILED_PRECONDITION waits the backoff before the lookup", async () => {
  const r = rig();
  r.t.lookup_(LIVE, { liveBroadcastContent: "live" }).stream_(grpcErr("FAILED_PRECONDITION"));
  await r.start();
  await r.clock.advance(999);
  assert.equal(r.t.of("lookup").length, 1, "no lookup before the 1 s backoff");
  await r.clock.advance(1);
  assert.equal(r.t.of("lookup").length, 2, "the lookup at 1 s");
  assert.equal(r.state(), "stopped");
});

// @spec CHAT-YT-045
test("a stream NOT_FOUND waits the backoff before the lookup, and stops only when the broadcast has ended", async () => {
  const ended = { liveBroadcastContent: "none" as const, actualEndTime: "2026-11-23T12:30:00Z" };
  const r = rig();
  r.t.lookup_(LIVE, ended).stream_(grpcErr("NOT_FOUND"));
  await r.start();
  await r.clock.advance(999);
  assert.equal(r.t.of("lookup").length, 1);
  await r.clock.advance(1);
  assert.equal(r.t.of("lookup").length, 2);
  assert.equal(r.state(), "stopped");
  assert.match(r.reason()!, /broadcast has ended/);
});

// @spec CHAT-YT-068
test("stream failures that trigger lookups are paced by the growing backoff, as on the poll path", async () => {
  const r = rig();
  r.t.lookup_(...Array.from({ length: 8 }, () => LIVE));
  r.t.stream_(...Array.from({ length: 8 }, () => grpcErr("FAILED_PRECONDITION")));
  await r.start();
  await r.clock.advance(200_000);
  const times = r.t.of("lookup").map((c) => c.at);
  assert.ok(times.length >= 6, `${times.length} lookups`);
  const gaps = times.slice(1).map((t, i) => t - times[i]!);
  [1000, 2000, 4000, 8000, 16000].forEach((min, i) => assert.ok(gaps[i]! >= min, `gap ${i} is ${gaps[i]}, at least ${min}`));
});

// @spec CHAT-YT-033
test("a stream that resumes after quota is opened with the token it held before the quota", async () => {
  const r = rig();
  r.t.lookup_(LIVE, LIVE).stream_(
    new StreamScript().open().respond(resp([text("h", 0)], { nextPageToken: "T1" })).fail(grpcErr("RESOURCE_EXHAUSTED")),
    new StreamScript().open().respond(resp([text("n", 20)])),
  );
  await r.start();
  await r.clock.advance(HOUR + 1000);
  const calls = r.t.of("stream");
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.pageToken, "T1", "the resume carries the last token");
  assert.deepEqual(r.texts(), ["n"]);
});

// @spec CHAT-SRC-005
test("the stream iterator is closed when a response says offlineAt, a chatEndedEvent arrives, or the source stops", async () => {
  const off = rig();
  const sOff = new StreamScript().open().respond(resp([], { offlineAt: "2026-11-23T13:00:00Z" }));
  off.t.lookup_(LIVE).stream_(sOff);
  await off.start();
  assert.equal(off.state(), "stopped");
  assert.equal(sOff.returned, 1, "offlineAt closes the call");

  const ended = rig();
  const sEnded = new StreamScript().open().respond(resp([chatEnded()]));
  ended.t.lookup_(LIVE).stream_(sEnded);
  await ended.start();
  assert.equal(ended.state(), "stopped");
  assert.equal(sEnded.returned, 1, "chatEndedEvent closes the call");

  const stopped = rig();
  const sOpen = new StreamScript().open();
  stopped.t.lookup_(LIVE).stream_(sOpen);
  await stopped.start();
  stopped.src.stop();
  await settle();
  assert.equal(sOpen.returned, 1, "stop closes the call");
});

// @spec CHAT-FORGET-002
test("a messageDeletedEvent removes its deleted message exactly as a tombstone does", async () => {
  const r = await afterHistory([text("h", 0)], [resp([{ id: "d1", snippet: { type: "messageDeletedEvent", publishedAt: at(5), messageDeletedDetails: { deletedMessageId: "m3" } }, authorDetails: { channelId: "UCmod" } }])]);
  await next(r);
  assert.deepEqual(r.removals, [{ scope: "message", messageId: "m3" }]);
});
