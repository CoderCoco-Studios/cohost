/**
 * The YouTube transport over real sockets: a local HTTP server stands in for www.googleapis.com and a local gRPC server
 * (the vendored stream_list.proto) for youtube.googleapis.com. The hosts are fixed in the transport; a test overrides
 * only the base URL and the stream target, never the request the transport builds.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import * as grpc from "@grpc/grpc-js";
import * as loader from "@grpc/proto-loader";
import { recordingLog, testConfig, waitFor } from "@cohost/testing";
import {
  createYouTubeTransport, STREAM_LIST_PROTO, YOUTUBE_REST_HOST, YOUTUBE_STREAM_TARGET, YouTubeApiError,
  type LiveChatListResponse, type StreamChunk, type YouTubeTransport,
} from "../src/youtube-transport.js";
import { mapLiveChatItem } from "../src/youtube-map.js";
import { YouTubeSource } from "../src/youtube.js";
import { CHAT, VIDEO } from "./youtube-helpers.js";

const KEY = "test-key-123";

interface RestRequest { method: string; path: string; query: URLSearchParams; headers: IncomingMessage["headers"] }
interface Servers {
  restRequests: RestRequest[];
  rest: { handler: (req: IncomingMessage, res: ServerResponse) => void };
  grpcCalls: { request: any; metadata: grpc.Metadata; call: grpc.ServerWritableStream<any, any> }[];
  grpcHandler: { fn: (call: grpc.ServerWritableStream<any, any>) => void };
  restBaseUrl: string;
  streamTarget: string;
  transport(over?: Record<string, unknown>): YouTubeTransport;
  close(): Promise<void>;
}

const protoDef = loader.loadSync(STREAM_LIST_PROTO, { enums: String, longs: String, defaults: false, oneofs: false });
const ytPackage = grpc.loadPackageDefinition(protoDef) as any;

/** The JSON a videos.list answers with for a live broadcast. */
const liveVideo = (over: Record<string, unknown> = {}) => ({
  items: [{ id: VIDEO, snippet: { liveBroadcastContent: "live", title: "t" }, liveStreamingDetails: { activeLiveChatId: CHAT, actualStartTime: "2026-11-23T11:00:00Z", scheduledStartTime: "2026-11-23T10:55:00Z", ...over } }],
});

async function servers(): Promise<Servers> {
  const restRequests: RestRequest[] = [];
  const rest = { handler: (_req: IncomingMessage, res: ServerResponse) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(liveVideo())); } };
  const http: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    restRequests.push({ method: req.method ?? "", path: url.pathname, query: url.searchParams, headers: req.headers });
    rest.handler(req, res);
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const httpPort = (http.address() as { port: number }).port;

  const grpcCalls: Servers["grpcCalls"] = [];
  const grpcHandler: Servers["grpcHandler"] = { fn: () => {} };
  const g = new grpc.Server();
  g.addService(ytPackage.youtube.api.v3.V3DataLiveChatMessageService.service, {
    StreamList: (call: grpc.ServerWritableStream<any, any>) => { grpcCalls.push({ request: call.request, metadata: call.metadata, call }); grpcHandler.fn(call); },
  });
  const grpcPort = await new Promise<number>((res, rej) => g.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (e, p) => (e ? rej(e) : res(p))));

  const restBaseUrl = `http://127.0.0.1:${httpPort}`;
  const streamTarget = `127.0.0.1:${grpcPort}`;
  return {
    restRequests, rest, grpcCalls, grpcHandler, restBaseUrl, streamTarget,
    transport: (over = {}) => createYouTubeTransport({ apiKey: KEY, restBaseUrl, streamTarget, streamInsecure: true, ...over }),
    close: async () => {
      http.closeAllConnections();
      await new Promise<void>((r) => http.close(() => r()));
      g.forceShutdown();
    },
  };
}

async function withServers(fn: (s: Servers) => Promise<void>): Promise<void> {
  const s = await servers();
  try { await fn(s); } finally { await s.close(); }
}

const json = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(typeof body === "string" ? body : JSON.stringify(body)); };
const apiError = (code: number, reason: string) => ({ error: { code, message: reason, errors: [{ reason, domain: "youtube.liveBroadcast" }] } });

async function take(it: AsyncIterator<StreamChunk>, ms = 3000): Promise<IteratorResult<StreamChunk>> {
  return Promise.race([it.next(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timed out waiting for a stream chunk")), ms))]);
}

// ---------------------------------------------------------------- REST: lookup and poll

// @spec CHAT-YT-007, CHAT-YT-001
test("lookup is one GET of videos.list with parts liveStreamingDetails and snippet, the video id and the API key, and nothing else", async () => {
  await withServers(async (s) => {
    const item = await s.transport().lookup(VIDEO);
    assert.equal(s.restRequests.length, 1);
    const q = s.restRequests[0]!;
    assert.equal(q.method, "GET");
    assert.equal(q.path, "/youtube/v3/videos");
    assert.equal(q.query.get("id"), VIDEO);
    assert.equal(q.query.get("part"), "liveStreamingDetails,snippet");
    assert.equal(q.query.get("key"), KEY);
    assert.deepEqual([...q.query.keys()].sort(), ["id", "key", "part"]);
    assert.equal(q.headers.authorization, undefined, "no OAuth token");
    assert.deepEqual(item, { liveBroadcastContent: "live", activeLiveChatId: CHAT, scheduledStartTime: "2026-11-23T10:55:00Z" });
  });
});

// @spec CHAT-YT-007
test("lookup carries the end time of an ended broadcast and none of an unknown video", async () => {
  await withServers(async (s) => {
    s.rest.handler = (_q, res) => json(res, 200, { items: [{ id: VIDEO, snippet: { liveBroadcastContent: "none" }, liveStreamingDetails: { actualEndTime: "2026-11-23T12:30:00Z" } }] });
    assert.deepEqual(await s.transport().lookup(VIDEO), { liveBroadcastContent: "none", actualEndTime: "2026-11-23T12:30:00Z" });
    s.rest.handler = (_q, res) => json(res, 200, { items: [] });
    assert.equal(await s.transport().lookup(VIDEO), undefined);
  });
});

// @spec CHAT-YT-049, CHAT-YT-032
test("an API error is thrown with its HTTP status and the API's reason", async () => {
  await withServers(async (s) => {
    s.rest.handler = (_q, res) => json(res, 403, apiError(403, "quotaExceeded"));
    await assert.rejects(s.transport().lookup(VIDEO), (e: unknown) => e instanceof YouTubeApiError && e.http === 403 && e.reason === "quotaExceeded");
    s.rest.handler = (_q, res) => json(res, 400, apiError(400, "pageTokenInvalid"));
    await assert.rejects(s.transport().poll({ chatId: CHAT, pageToken: "x" }), (e: unknown) => e instanceof YouTubeApiError && e.http === 400 && e.reason === "pageTokenInvalid");
    s.rest.handler = (_q, res) => json(res, 502, "<html>bad gateway</html>");
    await assert.rejects(s.transport().poll({ chatId: CHAT }), (e: unknown) => e instanceof YouTubeApiError && e.http === 502 && e.reason === undefined);
  });
});

// @spec CHAT-YT-049
test("a refused connection is a plain network failure, not an API error", async () => {
  const s = await servers();
  const t = s.transport();
  await s.close();
  await assert.rejects(t.lookup(VIDEO), (e: unknown) => e instanceof Error && !(e instanceof YouTubeApiError));
});

// @spec CHAT-YT-026, CHAT-YT-024, CHAT-YT-001
test("poll is one GET of liveChatMessages.list with the chat id, parts snippet and authorDetails, the page token and the key", async () => {
  await withServers(async (s) => {
    const body = { kind: "youtube#liveChatMessageListResponse", pollingIntervalMillis: 5000, nextPageToken: "NEXT", items: [{ id: "m1", snippet: { type: "textMessageEvent", textMessageDetails: { messageText: "hi" } }, authorDetails: { channelId: "UC1", displayName: "A" } }] };
    s.rest.handler = (_q, res) => json(res, 200, body);
    const got = await s.transport().poll({ chatId: CHAT, pageToken: "PREV" });
    assert.deepEqual(got, body, "the API's own JSON shape, unchanged");
    const q = s.restRequests[0]!;
    assert.equal(q.method, "GET");
    assert.equal(q.path, "/youtube/v3/liveChat/messages");
    assert.deepEqual(Object.fromEntries(q.query), { liveChatId: CHAT, part: "snippet,authorDetails", pageToken: "PREV", key: KEY });
    assert.equal(q.headers.authorization, undefined);
    await s.transport().poll({ chatId: CHAT });
    assert.equal(s.restRequests[1]!.query.has("pageToken"), false, "no page token when there is none");
  });
});

// @spec CHAT-SRC-005
test("an aborted signal cancels the request in flight", async () => {
  await withServers(async (s) => {
    s.rest.handler = () => {};
    const ac = new AbortController();
    const pending = s.transport().poll({ chatId: CHAT, signal: ac.signal });
    await waitFor(() => s.restRequests.length === 1, "the request to arrive");
    ac.abort();
    await assert.rejects(pending);
  });
});

// ---------------------------------------------------------------- egress

// @spec CHAT-YT-059
test("by default the REST calls go to https://www.googleapis.com and carry only the key, the ids and the parts", async () => {
  assert.equal(YOUTUBE_REST_HOST, "www.googleapis.com");
  assert.equal(YOUTUBE_STREAM_TARGET, "youtube.googleapis.com:443");
  const urls: { url: URL; init?: RequestInit }[] = [];
  const fakeFetch = (async (input: unknown, init?: RequestInit) => {
    urls.push({ url: new URL(String(input)), init });
    return new Response(JSON.stringify(liveVideo()), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const t = createYouTubeTransport({ apiKey: KEY, fetch: fakeFetch });
  await t.lookup(VIDEO);
  await t.poll({ chatId: CHAT, pageToken: "P" });
  assert.equal(urls.length, 2);
  for (const { url, init } of urls) {
    assert.equal(url.protocol, "https:");
    assert.equal(url.host, "www.googleapis.com");
    assert.equal(url.username + url.password, "");
    assert.equal(new Headers(init?.headers).has("authorization"), false);
    assert.equal(new Headers(init?.headers).has("cookie"), false);
    assert.ok([...url.searchParams.values()].every((v) => [KEY, VIDEO, CHAT, "P", "liveStreamingDetails,snippet", "snippet,authorDetails"].includes(v)), "no other value leaves the host");
  }
});

// @spec CHAT-YT-002
test("no environment variable supplies the key or any setting: only the configured key is sent", async () => {
  const sentinel = "ENV-SENTINEL-DO-NOT-SEND";
  const names = ["GOOGLE_API_KEY", "YOUTUBE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT", "YOUTUBE_VIDEO"];
  const saved = names.map((n) => process.env[n]);
  names.forEach((n) => { process.env[n] = sentinel; });
  try {
    await withServers(async (s) => {
      const t = s.transport();
      await t.lookup(VIDEO);
      await t.poll({ chatId: CHAT });
      s.grpcHandler.fn = (call) => { call.sendMetadata(new grpc.Metadata()); call.end(); };
      for await (const _ of t.openStream({ chatId: CHAT })) { /* drain */ }
      for (const r of s.restRequests) assert.ok(!r.path.includes(sentinel) && !r.query.toString().includes(sentinel) && !JSON.stringify(r.headers).includes(sentinel));
      assert.ok(!JSON.stringify(s.grpcCalls[0]!.metadata.getMap()).includes(sentinel));
      assert.equal(s.grpcCalls[0]!.metadata.get("x-goog-api-key")[0], KEY);
    });
  } finally {
    names.forEach((n, i) => { if (saved[i] === undefined) delete process.env[n]; else process.env[n] = saved[i]; });
  }
});

// @spec CHAT-YT-002, CHAT-YT-001
test("the YouTube modules read no environment variable, import no Google client library and hold no OAuth or send code", () => {
  const dir = fileURLToPath(new URL("../src/", import.meta.url));
  const files = readdirSync(dir).filter((f) => f.startsWith("youtube") && f.endsWith(".ts"));
  assert.ok(files.includes("youtube.ts") && files.includes("youtube-transport.ts") && files.includes("youtube-map.ts"), files.join(","));
  for (const f of files) {
    const src = readFileSync(join(dir, f), "utf8");
    assert.doesNotMatch(src, /process\.env|import\.meta\.env/, `${f} reads no environment variable`);
    assert.doesNotMatch(src, /from "(googleapis|google-auth-library|@google-cloud\/[^"]*|@googleapis\/[^"]*)"/, `${f} imports no Google client library`);
    assert.doesNotMatch(src, /oauth|access_token|insertLiveChat|liveChat\/bans|liveChat\/moderators|method:\s*"(POST|PUT|DELETE|PATCH)"/i, `${f} has no OAuth, send, ban or moderation call`);
  }
  const pkg = JSON.parse(readFileSync(join(dir, "../package.json"), "utf8")) as { dependencies: Record<string, string> };
  for (const name of Object.keys(pkg.dependencies)) assert.doesNotMatch(name, /^(googleapis|google-auth-library|@google-cloud\/|@googleapis\/)/, name);
  assert.ok(pkg.dependencies["@grpc/grpc-js"] && pkg.dependencies["@grpc/proto-loader"], "the gRPC stream is @grpc/grpc-js with @grpc/proto-loader");
});

// ---------------------------------------------------------------- gRPC stream

const baseText = (id: string, over: Record<string, unknown> = {}) => ({
  id, snippet: { type: "TEXT_MESSAGE_EVENT", publishedAt: "2026-11-23T12:00:05Z", textMessageDetails: { messageText: `text ${id}` } },
  authorDetails: { channelId: `UC${id}`, displayName: `name ${id}`, isChatModerator: true }, ...over,
});

// @spec CHAT-YT-015, CHAT-YT-001, CHAT-YT-059
test("the stream is StreamList for the chat id with parts snippet and authorDetails, the page token, and the key as x-goog-api-key metadata", async () => {
  await withServers(async (s) => {
    s.grpcHandler.fn = (call) => { call.sendMetadata(new grpc.Metadata()); };
    const it = s.transport().openStream({ chatId: CHAT, pageToken: "RESUME" })[Symbol.asyncIterator]();
    await take(it);
    const c = s.grpcCalls[0]!;
    assert.equal(c.request.liveChatId, CHAT);
    assert.deepEqual(c.request.part, ["snippet", "authorDetails"]);
    assert.equal(c.request.pageToken, "RESUME");
    assert.equal(c.metadata.get("x-goog-api-key")[0], KEY);
    assert.equal(c.metadata.get("authorization").length, 0, "no OAuth token");
    assert.equal(Object.keys(c.request).filter((k) => c.request[k] !== undefined && c.request[k] !== "" && !(Array.isArray(c.request[k]) && c.request[k].length === 0)).sort().join(), "liveChatId,pageToken,part");
    await it.return?.();
  });
});

// @spec CHAT-YT-016
test("the stream yields opened when the response begins with only its initial metadata, before any message", async () => {
  await withServers(async (s) => {
    let call!: grpc.ServerWritableStream<any, any>;
    s.grpcHandler.fn = (c) => { call = c; c.sendMetadata(new grpc.Metadata()); };
    const it = s.transport().openStream({ chatId: CHAT })[Symbol.asyncIterator]();
    const first = await take(it);
    assert.deepEqual(first.value, { type: "opened" });
    call.write({ nextPageToken: "N1", items: [baseText("m1")] });
    const second = await take(it);
    assert.equal((second.value as { type: string }).type, "response");
    await it.return?.();
  });
});

// @spec CHAT-YT-016
test("a stream whose first thing is a message yields opened first and then the response", async () => {
  await withServers(async (s) => {
    s.grpcHandler.fn = (c) => { c.write({ nextPageToken: "N1", items: [baseText("m1")] }); };
    const it = s.transport().openStream({ chatId: CHAT })[Symbol.asyncIterator]();
    assert.deepEqual((await take(it)).value, { type: "opened" });
    assert.equal(((await take(it)).value as { type: string }).type, "response");
    await it.return?.();
  });
});

// @spec CHAT-YT-029
test("a pushed batch is the API's own JSON shape: camel-case names, lower-camel types, absent fields absent", async () => {
  await withServers(async (s) => {
    s.grpcHandler.fn = (c) => {
      c.write({
        nextPageToken: "N1", offlineAt: "2026-11-23T13:00:00Z",
        items: [
          baseText("m1"),
          { id: "m2", snippet: { type: "TEXT_MESSAGE_EVENT", textMessageDetails: { messageText: "no time" } }, authorDetails: { channelId: "UCm2", displayName: "n2" } },
          { id: "t1", snippet: { type: "TOMBSTONE", publishedAt: "2026-11-23T12:00:06Z", messageDeletedDetails: { deletedMessageId: "m1" } }, authorDetails: { channelId: "UCmod" } },
          { id: "b1", snippet: { type: "USER_BANNED_EVENT", publishedAt: "2026-11-23T12:00:07Z", userBannedDetails: { bannedUserDetails: { channelId: "UCbad", displayName: "bad" }, banType: "TEMPORARY", banDurationSeconds: 300 } }, authorDetails: { channelId: "UCmod" } },
          { id: "b2", snippet: { type: "USER_BANNED_EVENT", publishedAt: "2026-11-23T12:00:08Z", userBannedDetails: { bannedUserDetails: { channelId: "UCbad2" }, banType: "PERMANENT" } }, authorDetails: { channelId: "UCmod" } },
          { id: "sc", snippet: { type: "SUPER_CHAT_EVENT", publishedAt: "2026-11-23T12:00:09Z", superChatDetails: { amountMicros: 5000000, currency: "USD", userComment: "thanks" } }, authorDetails: { channelId: "UCpay", displayName: "p" } },
          { id: "so", snippet: { type: "SPONSOR_ONLY_MODE_STARTED_EVENT", publishedAt: "2026-11-23T12:00:10Z" }, authorDetails: { channelId: "UCmod" } },
          { id: "ce", snippet: { type: "CHAT_ENDED_EVENT", publishedAt: "2026-11-23T12:00:11Z" }, authorDetails: { channelId: "UCmod" } },
        ],
      });
      c.end();
    };
    const chunks: StreamChunk[] = [];
    for await (const c of s.transport().openStream({ chatId: CHAT })) chunks.push(c);
    const response = (chunks.find((c) => c.type === "response") as { response: LiveChatListResponse }).response;
    assert.equal(response.nextPageToken, "N1");
    assert.equal(response.offlineAt, "2026-11-23T13:00:00Z");
    const items = response.items as any[];
    assert.equal(items[0].snippet.type, "textMessageEvent");
    assert.equal(items[0].snippet.textMessageDetails.messageText, "text m1");
    assert.equal(items[0].snippet.publishedAt, "2026-11-23T12:00:05Z");
    assert.equal(items[0].authorDetails.channelId, "UCm1");
    assert.equal(items[0].authorDetails.isChatModerator, true);
    assert.ok(!items[0].authorDetails.isChatOwner, "an unset flag is false or absent");
    assert.equal("publishedAt" in items[1].snippet, false, "an unset time is absent, not an empty string");
    assert.equal(items[2].snippet.type, "tombstone");
    assert.equal(items[2].snippet.messageDeletedDetails.deletedMessageId, "m1");
    assert.equal(items[3].snippet.userBannedDetails.bannedUserDetails.channelId, "UCbad");
    assert.equal(items[3].snippet.userBannedDetails.banType, "temporary");
    assert.equal(items[4].snippet.userBannedDetails.banType, "permanent");
    assert.equal(items[5].snippet.type, "superChatEvent");
    assert.equal(items[5].snippet.superChatDetails.userComment, "thanks");
    assert.equal(items[6].snippet.type, "sponsorOnlyModeStartedEvent");
    assert.equal(items[7].snippet.type, "chatEndedEvent");
    // the same mapper reads both transports' items
    const kinds = items.map((i) => mapLiveChatItem(i).kind);
    assert.deepEqual(kinds, ["message", "message", "removal", "removal", "removal", "message", "notice", "ended"]);
    assert.deepEqual(mapLiveChatItem(items[3]), { kind: "removal", removal: { scope: "user", userId: "UCbad", reason: "timeout" }, markerId: "b1" });
  });
});

// @spec CHAT-YT-018
test("the server closing the stream ends the iteration without an error", async () => {
  await withServers(async (s) => {
    s.grpcHandler.fn = (c) => { c.sendMetadata(new grpc.Metadata()); c.end(); };
    const chunks: StreamChunk[] = [];
    for await (const c of s.transport().openStream({ chatId: CHAT })) chunks.push(c);
    assert.deepEqual(chunks, [{ type: "opened" }]);
  });
});

// @spec CHAT-YT-020, CHAT-YT-022, CHAT-YT-042, CHAT-YT-044, CHAT-YT-045, CHAT-YT-048, CHAT-YT-049
test("a stream failure is thrown with the gRPC status name", async () => {
  await withServers(async (s) => {
    const cases: [grpc.status, string][] = [
      [grpc.status.UNIMPLEMENTED, "UNIMPLEMENTED"], [grpc.status.PERMISSION_DENIED, "PERMISSION_DENIED"], [grpc.status.UNAUTHENTICATED, "UNAUTHENTICATED"],
      [grpc.status.FAILED_PRECONDITION, "FAILED_PRECONDITION"], [grpc.status.NOT_FOUND, "NOT_FOUND"], [grpc.status.RESOURCE_EXHAUSTED, "RESOURCE_EXHAUSTED"],
      [grpc.status.INVALID_ARGUMENT, "INVALID_ARGUMENT"], [grpc.status.INTERNAL, "INTERNAL"], [grpc.status.DEADLINE_EXCEEDED, "DEADLINE_EXCEEDED"],
    ];
    for (const [code, name] of cases) {
      s.grpcHandler.fn = (c) => { c.emit("error", { code, details: `server said ${name}` }); };
      await assert.rejects(
        async () => { for await (const _ of s.transport().openStream({ chatId: CHAT })) { /* drain */ } },
        (e: unknown) => e instanceof YouTubeApiError && e.grpc === name, name,
      );
    }
  });
});

// @spec CHAT-YT-049
test("a stream that cannot connect fails with UNAVAILABLE", async () => {
  const s = await servers();
  const t = s.transport();
  await s.close();
  await assert.rejects(
    async () => { for await (const _ of t.openStream({ chatId: CHAT })) { /* drain */ } },
    (e: unknown) => e instanceof YouTubeApiError && e.grpc === "UNAVAILABLE",
  );
});

// @spec CHAT-SRC-005
test("an aborted signal cancels the open stream call", async () => {
  await withServers(async (s) => {
    let cancelled = false;
    s.grpcHandler.fn = (c) => { c.sendMetadata(new grpc.Metadata()); c.on("cancelled", () => { cancelled = true; }); };
    const ac = new AbortController();
    const it = s.transport().openStream({ chatId: CHAT, signal: ac.signal })[Symbol.asyncIterator]();
    await take(it);
    ac.abort();
    await waitFor(() => cancelled, "the server to see the cancel");
    const end = await Promise.race([it.next().then((r) => r, () => ({ done: true })), new Promise((r) => setTimeout(() => r("hung"), 2000))]);
    assert.notEqual(end, "hung", "the iteration ends or rejects after an abort");
  });
});

// ---------------------------------------------------------------- the source on real transports

const sourceFor = (s: Servers, youtube: Record<string, unknown>) => {
  const cfg = testConfig({ chat: { sources: ["youtube"], youtube: { api_key: KEY, video: VIDEO, ...youtube } } });
  return new YouTubeSource({ videoId: VIDEO, youtube: cfg.chat.youtube, transport: s.transport() });
};
const harness = () => {
  const sent: string[] = [];
  const removals: unknown[] = [];
  const states: string[] = [];
  const log = recordingLog();
  return { sent, removals, states, log, env: { emit: (_s: unknown, t: string) => { sent.push(t); }, emitRemoval: (r: unknown) => { removals.push(r); }, log: log.log, onState: (st: string) => { states.push(st); } } };
};

// @spec CHAT-YT-010, CHAT-YT-015, CHAT-YT-016, CHAT-YT-034, CHAT-YT-035, CHAT-FORGET-002
test("end to end over the stream: lookup over HTTP, history dropped, a new message and a deletion read from the gRPC stream", async () => {
  await withServers(async (s) => {
    s.grpcHandler.fn = (c) => {
      c.sendMetadata(new grpc.Metadata());
      c.write({ nextPageToken: "N1", items: [{ ...baseText("hist"), snippet: { type: "TEXT_MESSAGE_EVENT", publishedAt: "2026-11-23T12:00:00Z", textMessageDetails: { messageText: "old chat" } } }] });
      setTimeout(() => c.write({ nextPageToken: "N2", items: [baseText("new"), { id: "t1", snippet: { type: "TOMBSTONE", publishedAt: "2026-11-23T12:00:06Z", messageDeletedDetails: { deletedMessageId: "gone" } }, authorDetails: { channelId: "UCmod" } }] }), 50);
    };
    const src = sourceFor(s, {});
    const h = harness();
    await src.start(h.env as never);
    try {
      await waitFor(() => h.sent.length === 1 && h.removals.length === 1, "the new message and the removal", 5000);
      assert.deepEqual(h.sent, ["text new"]);
      assert.deepEqual(h.removals, [{ scope: "message", messageId: "gone" }]);
      assert.equal(src.state().state, "reading");
      assert.equal(s.restRequests.length, 1, "one lookup");
      assert.equal(s.grpcCalls.length, 1, "one stream");
    } finally {
      src.stop();
    }
  });
});

// @spec CHAT-YT-026, CHAT-YT-027, CHAT-YT-028, CHAT-YT-034, CHAT-YT-035
test("end to end by polling: lookup and polls over HTTP, the floor between polls, the token carried, history dropped", async () => {
  await withServers(async (s) => {
    let polls = 0;
    s.rest.handler = (req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      if (url.pathname === "/youtube/v3/videos") return json(res, 200, liveVideo());
      polls++;
      if (polls === 1) return json(res, 200, { pollingIntervalMillis: 200, nextPageToken: "P1", items: [{ id: "h", snippet: { type: "textMessageEvent", publishedAt: "2026-11-23T12:00:00Z", textMessageDetails: { messageText: "old" } }, authorDetails: { channelId: "UCh", displayName: "h" } }] });
      return json(res, 200, { pollingIntervalMillis: 200, nextPageToken: "P2", items: [{ id: "n", snippet: { type: "textMessageEvent", publishedAt: "2026-11-23T12:00:09Z", textMessageDetails: { messageText: "fresh" } }, authorDetails: { channelId: "UCn", displayName: "n" } }] });
    };
    const src = sourceFor(s, { transport: "poll", poll_floor_ms: 1000 });
    const h = harness();
    const t0 = Date.now();
    await src.start(h.env as never);
    try {
      await waitFor(() => h.sent.length === 1, "the fresh message", 6000);
      assert.deepEqual(h.sent, ["fresh"]);
      assert.ok(Date.now() - t0 >= 950, "the 1000 ms floor, not the server's 200 ms, set the wait");
      const pollReqs = s.restRequests.filter((r) => r.path === "/youtube/v3/liveChat/messages");
      assert.equal(pollReqs[0]!.query.has("pageToken"), false);
      assert.equal(pollReqs[1]!.query.get("pageToken"), "P1");
      assert.equal(s.grpcCalls.length, 0, "no stream was opened");
      assert.equal(src.state().state, "reading");
    } finally {
      src.stop();
    }
  });
});
