import { fileURLToPath } from "node:url";
import type { LiveChatItem } from "./youtube-map.js";

/** The hosts are fixed in code: no setting decides where the key travels (CHAT-YT-059). */
export const YOUTUBE_REST_HOST = "www.googleapis.com";
export const YOUTUBE_STREAM_TARGET = "youtube.googleapis.com:443";
/** The vendored `StreamList` proto (services/chat/proto/stream_list.proto). */
export const STREAM_LIST_PROTO = fileURLToPath(new URL("../proto/stream_list.proto", import.meta.url));

/** A failed call: the HTTP status or gRPC status name, and the API's `reason` where it gave one. */
export class YouTubeApiError extends Error {
  readonly http?: number;
  readonly grpc?: string;
  readonly reason?: string;
  constructor(message: string, opts: { http?: number; grpc?: string; reason?: string }) {
    super(message);
    this.name = "YouTubeApiError";
    this.http = opts.http;
    this.grpc = opts.grpc;
    this.reason = opts.reason;
  }
}

/** The video lookup's answer, flat (CHAT-YT-007). */
export interface LookupItem {
  liveBroadcastContent: "live" | "upcoming" | "none";
  activeLiveChatId?: string;
  actualEndTime?: string;
  scheduledStartTime?: string;
}

/** A `liveChatMessageListResponse` in the API's own JSON shape (CHAT-YT-029). */
export interface LiveChatListResponse {
  items?: LiveChatItem[];
  nextPageToken?: string;
  pollingIntervalMillis?: number;
  offlineAt?: string;
  [key: string]: unknown;
}

/** One stream chunk: `opened` when the call's response begins, then each pushed batch. */
export type StreamChunk = { type: "opened" } | { type: "response"; response: LiveChatListResponse };

/** Every API access the YouTube source makes (CHAT-YT-029). */
export interface YouTubeTransport {
  lookup(videoId: string, signal?: AbortSignal): Promise<LookupItem | undefined>;
  openStream(req: { chatId: string; pageToken?: string; signal?: AbortSignal }): AsyncIterable<StreamChunk>;
  poll(req: { chatId: string; pageToken?: string; signal?: AbortSignal }): Promise<LiveChatListResponse>;
}

export interface YouTubeTransportOptions {
  apiKey: string;
  /** Test seam: the fetch used for the REST calls. */
  fetch?: typeof fetch;
  /** Test seam: the REST origin (default `https://www.googleapis.com`). */
  restBaseUrl?: string;
  /** Test seam: the gRPC target (default `youtube.googleapis.com:443`). */
  streamTarget?: string;
  /** Test seam: plaintext gRPC for a local server. */
  streamInsecure?: boolean;
}

/** Google's `pageTokenInvalid` and `quotaExceeded` reasons are read from the error body (`error.errors[0].reason`). */
function restError(status: number, body: string): YouTubeApiError {
  let reason: string | undefined;
  try {
    const parsed = JSON.parse(body) as { error?: { errors?: { reason?: string }[] } };
    reason = parsed.error?.errors?.[0]?.reason;
  } catch {
    reason = undefined;
  }
  return new YouTubeApiError(`YouTube API answered ${status}${reason ? ` ${reason}` : ""}`, { http: status, reason });
}

/** `TEXT_MESSAGE_EVENT` → `textMessageEvent`: the enum names the API's JSON uses. */
const enumToApi = (name: string): string => name.toLowerCase().replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** A proto message as the API's JSON: enum names in their JSON form, unset fields absent. */
function toApiItem(raw: Record<string, any>): LiveChatItem {
  const item: LiveChatItem = { ...raw };
  if (raw.snippet) {
    const snippet: Record<string, any> = { ...raw.snippet };
    if (typeof snippet.type === "string") snippet.type = enumToApi(snippet.type);
    if (snippet.userBannedDetails && typeof snippet.userBannedDetails.banType === "string") {
      snippet.userBannedDetails = { ...snippet.userBannedDetails, banType: enumToApi(snippet.userBannedDetails.banType) };
    }
    item.snippet = snippet;
  }
  return item;
}

/** Builds the transport: REST through `fetch` to www.googleapis.com, the stream through @grpc/grpc-js to youtube.googleapis.com. */
// @spec CHAT-YT-001, CHAT-YT-002, CHAT-YT-007, CHAT-YT-015, CHAT-YT-026, CHAT-YT-029, CHAT-YT-059
export function createYouTubeTransport(opts: YouTubeTransportOptions): YouTubeTransport {
  const fetchImpl = opts.fetch ?? fetch;
  const restBase = opts.restBaseUrl ?? `https://${YOUTUBE_REST_HOST}`;
  const streamTarget = opts.streamTarget ?? YOUTUBE_STREAM_TARGET;

  async function getJson(path: string, params: Record<string, string>, signal?: AbortSignal): Promise<any> {
    const url = new URL(`${restBase}${path}`);
    for (const [k, v] of Object.entries({ ...params, key: opts.apiKey })) url.searchParams.set(k, v);
    const res = await fetchImpl(url, { signal, headers: { accept: "application/json" } });
    const body = await res.text();
    if (!res.ok) throw restError(res.status, body);
    return JSON.parse(body);
  }

  return {
    async lookup(videoId, signal) {
      const json = await getJson("/youtube/v3/videos", { id: videoId, part: "liveStreamingDetails,snippet" }, signal);
      const video = json.items?.[0];
      if (!video) return undefined;
      const details = video.liveStreamingDetails ?? {};
      const found: LookupItem = { liveBroadcastContent: video.snippet?.liveBroadcastContent ?? "none" };
      if (details.activeLiveChatId) found.activeLiveChatId = details.activeLiveChatId;
      if (details.actualEndTime) found.actualEndTime = details.actualEndTime;
      if (details.scheduledStartTime) found.scheduledStartTime = details.scheduledStartTime;
      return found;
    },

    poll({ chatId, pageToken, signal }) {
      const params: Record<string, string> = { liveChatId: chatId, part: "snippet,authorDetails" };
      if (pageToken !== undefined) params.pageToken = pageToken;
      return getJson("/youtube/v3/liveChat/messages", params, signal);
    },

    openStream(req) {
      return streamList(req);
    },
  };

  async function* streamList(req: { chatId: string; pageToken?: string; signal?: AbortSignal }): AsyncGenerator<StreamChunk> {
    const grpc = await import("@grpc/grpc-js");
    const loader = await import("@grpc/proto-loader");
    const definition = loader.loadSync(STREAM_LIST_PROTO, { keepCase: false, longs: String, enums: String, defaults: false, oneofs: false });
    const pkg = grpc.loadPackageDefinition(definition) as unknown as { youtube: { api: { v3: { V3DataLiveChatMessageService: new (target: string, creds: unknown) => any } } } };
    const Service = pkg.youtube.api.v3.V3DataLiveChatMessageService;
    const client = new Service(streamTarget, opts.streamInsecure ? grpc.credentials.createInsecure() : grpc.credentials.createSsl());
    const metadata = new grpc.Metadata();
    metadata.set("x-goog-api-key", opts.apiKey);
    const request: Record<string, unknown> = { liveChatId: req.chatId, part: ["snippet", "authorDetails"] };
    if (req.pageToken !== undefined) request.pageToken = req.pageToken;
    const call = client.StreamList(request, metadata) as import("@grpc/grpc-js").ClientReadableStream<Record<string, any>>;

    const queue: StreamChunk[] = [];
    let finished = false;
    let failure: YouTubeApiError | undefined;
    let wake: (() => void) | undefined;
    const notify = () => { const w = wake; wake = undefined; w?.(); };
    let opened = false;
    const begin = () => { if (!opened) { opened = true; queue.push({ type: "opened" }); notify(); } };
    call.on("metadata", begin);
    call.on("data", (msg: Record<string, any>) => {
      begin();
      const response: LiveChatListResponse = { items: (msg.items ?? []).map(toApiItem) };
      if (msg.nextPageToken) response.nextPageToken = msg.nextPageToken;
      if (msg.offlineAt) response.offlineAt = msg.offlineAt;
      queue.push({ type: "response", response });
      notify();
    });
    call.on("end", () => { finished = true; notify(); });
    call.on("error", (err: { code?: number; details?: string }) => {
      const name = Object.keys(grpc.status).find((k) => (grpc.status as unknown as Record<string, number>)[k] === err.code) ?? "UNKNOWN";
      failure = new YouTubeApiError(err.details ?? name, { grpc: name });
      finished = true;
      notify();
    });
    const onAbort = () => call.cancel();
    if (req.signal?.aborted) onAbort();
    req.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      for (;;) {
        const next = queue.shift();
        if (next) { yield next; continue; }
        if (finished) {
          if (failure) throw failure;
          return;
        }
        await new Promise<void>((resolve) => { wake = resolve; });
      }
    } finally {
      req.signal?.removeEventListener("abort", onAbort);
      if (!finished) call.cancel();
      client.close();
    }
  }
}
