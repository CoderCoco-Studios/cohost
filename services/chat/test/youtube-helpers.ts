/**
 * Shared doubles for the YouTube source tests (not a test file: node --test does not run it).
 *
 * The tests pin this surface, which the implementation must provide (docs/intent/chat/chat-design.md, "The transport"):
 *
 *   src/youtube-transport.ts
 *     YouTubeApiError(message, { http?, grpc?, reason? })  the thrown failure: HTTP status or gRPC status name, plus the API reason
 *     YouTubeTransport { lookup(videoId, signal?), openStream({chatId, pageToken?, signal}), poll({chatId, pageToken?, signal}) }
 *       lookup   -> LookupItem | undefined (flat: liveBroadcastContent, activeLiveChatId?, actualEndTime?, scheduledStartTime?)
 *       openStream -> AsyncIterable<{type:"opened"} | {type:"response", response: LiveChatListResponse}>
 *       poll     -> LiveChatListResponse (the API's JSON: items, nextPageToken, pollingIntervalMillis, offlineAt)
 *     createYouTubeTransport({ apiKey, fetch?, restBaseUrl?, streamTarget?, streamInsecure? })
 *     YOUTUBE_REST_HOST, YOUTUBE_STREAM_TARGET, STREAM_LIST_PROTO
 *   src/youtube-map.ts
 *     mapLiveChatItem(item) -> { kind: "message", sender, text, messageId }
 *                            | { kind: "removal", removal, markerId } | { kind: "unusable", type }
 *                            | { kind: "notice", notice } | { kind: "ended" } | { kind: "none" }
 *   src/youtube.ts
 *     new YouTubeSource({ videoId, youtube: Config["chat"]["youtube"], transport?, clock? })
 *     the clock is a ChatClock (setTimeout, clearTimeout) and every wait, retry and tally interval runs on it.
 *     The tally is logged at info with the message "youtube quota tally" and the object { units, batches }.
 */
import { recordingLog, testConfig } from "@cohost/testing";
import type { ChatSender } from "../src/filter.js";
import type { ChatRemoval } from "../src/source.js";
import { YouTubeSource } from "../src/youtube.js";
import { YouTubeApiError } from "../src/youtube-transport.js";
import type { LiveChatListResponse, LookupItem, StreamChunk, YouTubeTransport } from "../src/youtube-transport.js";

export { YouTubeApiError };
export type { LiveChatListResponse, LookupItem, StreamChunk };

export const VIDEO = "dQw4w9WgXcQ";
export const CHAT = "chat-1";

/** Let promise continuations and queued immediates run. */
export async function settle(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}

/** A manual clock: timers fire only when `advance` reaches them. */
export class FakeClock {
  now = 0;
  private seq = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.timers.set(id, { at: this.now + Math.max(0, ms), fn });
    return id;
  }
  clearTimeout(handle: unknown): void { this.timers.delete(handle as number); }
  get pending(): number { return this.timers.size; }
  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | undefined;
      for (const e of this.timers) if (e[1].at <= target && (!next || e[1].at < next[1].at)) next = e;
      if (!next) break;
      this.timers.delete(next[0]);
      this.now = Math.max(this.now, next[1].at);
      next[1].fn();
      await settle();
    }
    this.now = target;
    await settle();
  }
}

export const T0 = Date.UTC(2026, 10, 23, 12, 0, 0);
/** A YouTube `publishedAt` string `sec` seconds after T0. */
export const at = (sec: number): string => new Date(T0 + sec * 1000).toISOString();

type Author = { channelId?: string; displayName?: string; isChatModerator?: boolean; isChatOwner?: boolean; isChatSponsor?: boolean };
export type Item = Record<string, any>;

/** A `textMessageEvent` resource. `sec` undefined leaves `publishedAt` out. */
export function text(id: string, sec: number | undefined, body = id, author: Author = {}): Item {
  return {
    kind: "youtube#liveChatMessage",
    id,
    snippet: { type: "textMessageEvent", ...(sec === undefined ? {} : { publishedAt: at(sec) }), hasDisplayContent: true, displayMessage: body, textMessageDetails: { messageText: body } },
    authorDetails: { channelId: `UC-${id}`, displayName: `name-${id}`, isChatModerator: false, isChatOwner: false, isChatSponsor: false, ...author },
  };
}

/** A `tombstone` resource deleting `deletedId`. */
export function tombstone(id: string, deletedId: string | undefined, sec: number | undefined = undefined): Item {
  return {
    id,
    snippet: { type: "tombstone", ...(sec === undefined ? {} : { publishedAt: at(sec) }), ...(deletedId === undefined ? {} : { messageDeletedDetails: { deletedMessageId: deletedId } }) },
    authorDetails: { channelId: "UC-mod", displayName: "mod" },
  };
}

/** A `userBannedEvent` resource. */
export function banned(id: string, channelId: string | undefined, banType: "permanent" | "temporary" = "permanent", sec: number | undefined = undefined): Item {
  return {
    id,
    snippet: {
      type: "userBannedEvent", ...(sec === undefined ? {} : { publishedAt: at(sec) }),
      userBannedDetails: { ...(channelId === undefined ? {} : { bannedUserDetails: { channelId, displayName: "x" } }), banType, ...(banType === "temporary" ? { banDurationSeconds: "300" } : {}) },
    },
    authorDetails: { channelId: "UC-mod", displayName: "mod" },
  };
}

export const chatEnded = (id = "end-1", sec = 1): Item => ({ id, snippet: { type: "chatEndedEvent", publishedAt: at(sec) }, authorDetails: { channelId: "UC-owner" } });

/** A response in the API's JSON shape. The server's interval is 1 s, so the floor decides the poll wait unless a test sets it. */
export const resp = (items: Item[], over: Record<string, unknown> = {}): LiveChatListResponse =>
  ({ kind: "youtube#liveChatMessageListResponse", pollingIntervalMillis: 1000, nextPageToken: "tok", items, ...over }) as LiveChatListResponse;

export const LIVE: LookupItem = { liveBroadcastContent: "live", activeLiveChatId: CHAT };

/** A stream the test drives by hand: `open()`, `respond()`, `fail()`, `end()`. */
export class StreamScript {
  private chunks: ({ chunk: StreamChunk } | { error: unknown } | { end: true })[] = [];
  private wake?: () => void;
  signal?: AbortSignal;
  /** How many times the source closed the call (`return` on the iterator). */
  returned = 0;
  private push(x: StreamScript["chunks"][number]) { this.chunks.push(x); this.wake?.(); }
  open() { this.push({ chunk: { type: "opened" } as StreamChunk }); return this; }
  respond(r: LiveChatListResponse) { this.push({ chunk: { type: "response", response: r } as StreamChunk }); return this; }
  fail(err: unknown) { this.push({ error: err }); return this; }
  end() { this.push({ end: true }); return this; }
  get aborted(): boolean { return this.signal?.aborted === true; }
  iterable(signal: AbortSignal | undefined): AsyncIterable<StreamChunk> {
    this.signal = signal;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<StreamChunk>> {
            for (;;) {
              const head = self.chunks.shift();
              if (head) {
                if ("error" in head) throw head.error;
                if ("end" in head) return { done: true, value: undefined };
                return { done: false, value: head.chunk };
              }
              if (signal?.aborted) return { done: true, value: undefined };
              await new Promise<void>((res) => { self.wake = res; signal?.addEventListener("abort", () => res(), { once: true }); });
            }
          },
          async return(): Promise<IteratorResult<StreamChunk>> { self.returned += 1; return { done: true, value: undefined }; },
        };
      },
    };
  }
}

type Step<T> = T | Error | ((call: Call) => T | Promise<T>);
export interface Call { kind: "lookup" | "stream" | "poll"; at: number; videoId?: string; chatId?: string; pageToken?: string; signal?: AbortSignal }

/** A transport that answers from queues, records every call with the fake clock's time, and hangs (until aborted) when its queue is empty. */
export class ScriptedTransport implements YouTubeTransport {
  calls: Call[] = [];
  private lookups: Step<LookupItem | undefined>[] = [];
  private polls: Step<LiveChatListResponse>[] = [];
  private streams: (StreamScript | Error)[] = [];
  /** When set, every poll after the queue is empty is answered by this. */
  pollForever?: (call: Call) => LiveChatListResponse;
  constructor(private readonly clock: FakeClock) {}

  lookup_(...s: Step<LookupItem | undefined>[]) { this.lookups.push(...s); return this; }
  poll_(...s: Step<LiveChatListResponse>[]) { this.polls.push(...s); return this; }
  stream_(...s: (StreamScript | Error)[]) { this.streams.push(...s); return this; }
  of(kind: Call["kind"]): Call[] { return this.calls.filter((c) => c.kind === kind); }

  private async answer<T>(queue: Step<T>[], call: Call, fallback?: (c: Call) => T): Promise<T> {
    this.calls.push(call);
    // An `undefined` step is an answer (no item), so an empty queue is tested by length, not by the step's value.
    const empty = queue.length === 0;
    const step = empty ? undefined : queue.shift();
    if (empty) {
      if (fallback) return fallback(call);
      return new Promise<T>((_, rej) => {
        const err = Object.assign(new Error("aborted"), { name: "AbortError" });
        if (call.signal?.aborted) rej(err);
        call.signal?.addEventListener("abort", () => rej(err), { once: true });
      });
    }
    if (step instanceof Error) throw step;
    return typeof step === "function" ? (step as (c: Call) => T | Promise<T>)(call) : step;
  }

  lookup(videoId: string, signal?: AbortSignal): Promise<LookupItem | undefined> {
    return this.answer(this.lookups, { kind: "lookup", at: this.clock.now, videoId, signal });
  }
  poll(req: { chatId: string; pageToken?: string; signal?: AbortSignal }): Promise<LiveChatListResponse> {
    return this.answer(this.polls, { kind: "poll", at: this.clock.now, chatId: req.chatId, pageToken: req.pageToken, signal: req.signal }, this.pollForever);
  }
  openStream(req: { chatId: string; pageToken?: string; signal?: AbortSignal }): AsyncIterable<StreamChunk> {
    this.calls.push({ kind: "stream", at: this.clock.now, chatId: req.chatId, pageToken: req.pageToken, signal: req.signal });
    const next = this.streams.shift() ?? new StreamScript();
    if (next instanceof Error) {
      return { [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(next) }) } as AsyncIterable<StreamChunk>;
    }
    return next.iterable(req.signal);
  }
}

export const apiErr = (http: number, reason?: string) => new YouTubeApiError(`http ${http} ${reason ?? ""}`, { http, reason });
export const grpcErr = (grpc: string, reason?: string) => new YouTubeApiError(`grpc ${grpc}`, { grpc, reason });
export const netErr = () => Object.assign(new Error("fetch failed"), { cause: { code: "ECONNRESET" } });

export interface Rig {
  src: YouTubeSource;
  clock: FakeClock;
  t: ScriptedTransport;
  sent: { sender: ChatSender; text: string; messageId?: string }[];
  removals: ChatRemoval[];
  states: { state: string; reason?: string }[];
  rec: ReturnType<typeof recordingLog>;
  texts(): string[];
  start(): Promise<void>;
  state(): string;
  reason(): string | undefined;
  /** The info lines logged with this message, with their objects. */
  infos(msg: string): unknown[];
}

/** A YouTube source on a scripted transport and a fake clock, with the `emit` side recorded. `poll_floor_ms` defaults to 1000 here. */
export function rig(youtube: Record<string, unknown> = {}, opts: { videoId?: string } = {}): Rig {
  const cfg = testConfig({ chat: { sources: ["youtube"], youtube: { api_key: "k", video: VIDEO, poll_floor_ms: 1000, ...youtube } } });
  const clock = new FakeClock();
  const t = new ScriptedTransport(clock);
  const rec = recordingLog();
  const sent: Rig["sent"] = [];
  const removals: ChatRemoval[] = [];
  const states: Rig["states"] = [];
  const src = new YouTubeSource({ videoId: opts.videoId ?? VIDEO, youtube: cfg.chat.youtube, transport: t, clock });
  const env = {
    emit: (sender: ChatSender, text: string, messageId?: string) => { sent.push({ sender, text, messageId }); },
    emitRemoval: (r: ChatRemoval) => { removals.push(r); },
    log: rec.log,
    onState: (state: string, reason?: string) => { states.push({ state, reason }); },
  };
  return {
    src, clock, t, sent, removals, states, rec,
    texts: () => sent.map((s) => s.text),
    start: async () => { await src.start(env as never); await settle(); },
    state: () => src.state().state,
    reason: () => src.state().reason,
    infos: (msg) => rec.lines.filter((l) => l.level === "info" && l.msg === msg).map((l) => l.obj),
  };
}
