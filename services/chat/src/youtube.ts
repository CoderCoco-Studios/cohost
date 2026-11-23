import type { Config } from "@cohost/config";
import type { ChatRemoval, ChatSource, ChatSourceStartEnv, ChatSourceState, ChatSourceStatus } from "./source.js";
import { mapLiveChatItem, type LiveChatItem, type MapResult } from "./youtube-map.js";
import {
  createYouTubeTransport, YouTubeApiError, type LiveChatListResponse, type LookupItem, type YouTubeTransport,
} from "./youtube-transport.js";

/** The clock every wait, retry and tally interval runs on; a test injects a fake one. */
export interface YouTubeClock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface YouTubeSourceOptions {
  videoId: string;
  youtube: Config["chat"]["youtube"];
  transport?: YouTubeTransport;
  clock?: YouTubeClock;
}

const HOUR_MS = 3_600_000;
const BACKOFF_START_MS = 1000;
const BACKOFF_CAP_MS = 60_000;
const TALLY_MS = 600_000;
const WINDOW_MS = 60_000;
const SEEN_LIMIT = 2000;
const STREAM_ATTEMPTS_BEFORE_POLLING = 5;

const systemClock: YouTubeClock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** What a failed call means for the source (the error table, CHAT-YT-040..050, CHAT-YT-068). */
type Failure =
  | { kind: "quota" }
  | { kind: "auth" }
  | { kind: "keyRejected" }
  | { kind: "chatRefusesKey" }
  | { kind: "streamDenied" }
  | { kind: "unimplemented" }
  | { kind: "chatGone" }
  | { kind: "chatNotFound" }
  | { kind: "pageToken" }
  | { kind: "rateLimit" }
  | { kind: "refused"; reason: string }
  | { kind: "transient" };

// @spec CHAT-YT-020, CHAT-YT-022, CHAT-YT-030, CHAT-YT-032, CHAT-YT-040, CHAT-YT-041, CHAT-YT-042, CHAT-YT-043, CHAT-YT-044, CHAT-YT-045, CHAT-YT-046, CHAT-YT-047, CHAT-YT-048, CHAT-YT-049
/** Sorts a failed call by the error table; anything the table does not name is transient. */
function classify(err: unknown, call: "lookup" | "stream" | "poll"): Failure {
  if (!(err instanceof YouTubeApiError)) return { kind: "transient" };
  const { http, grpc, reason } = err;
  if (reason === "quotaExceeded" || grpc === "RESOURCE_EXHAUSTED") return { kind: "quota" };
  if (http === 401 || grpc === "UNAUTHENTICATED") return { kind: "auth" };
  if (call === "lookup" && (grpc === "PERMISSION_DENIED" || (http === 403 && reason === "forbidden"))) return { kind: "keyRejected" };
  if (call === "poll" && http === 403 && reason === "forbidden") return { kind: "chatRefusesKey" };
  if (grpc === "PERMISSION_DENIED") return { kind: "streamDenied" };
  if (grpc === "UNIMPLEMENTED") return { kind: "unimplemented" };
  if (reason === "liveChatDisabled" || reason === "liveChatEnded" || grpc === "FAILED_PRECONDITION") return { kind: "chatGone" };
  if (reason === "liveChatNotFound" || grpc === "NOT_FOUND") return { kind: "chatNotFound" };
  if (reason === "pageTokenInvalid" || grpc === "INVALID_ARGUMENT") return { kind: "pageToken" };
  if (reason === "rateLimitExceeded") return { kind: "rateLimit" };
  if (http === 400 || http === 403) return { kind: "refused", reason: reason ?? `HTTP ${http}` };
  return { kind: "transient" };
}

const millis = (iso: unknown): number | undefined => {
  if (typeof iso !== "string") return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : t;
};

/**
 * The YouTube live chat source: looks the video up, reads its chat by the stream with polling decided at start, keeps
 * history and duplicates out, and reports removals. One state machine; every wait runs on the injected clock.
 */
// @spec CHAT-YT-001, CHAT-YT-002, CHAT-YT-003, CHAT-YT-007, CHAT-YT-014, CHAT-YT-021, CHAT-YT-023, CHAT-YT-026, CHAT-YT-029, CHAT-YT-031, CHAT-YT-039, CHAT-SRC-005, CHAT-SRC-006
export class YouTubeSource implements ChatSource {
  readonly name = "youtube" as const;

  private readonly videoId: string;
  private readonly settings: Config["chat"]["youtube"];
  private readonly transport: YouTubeTransport;
  private readonly clock: YouTubeClock;
  private readonly ac = new AbortController();
  private env?: ChatSourceStartEnv;
  private status: ChatSourceStatus = { state: "starting" };
  private stopped = false;
  private wakers = new Set<() => void>();
  private tallyTimer?: unknown;

  // Quota tally: in-process only (CHAT-YT-030, CHAT-YT-031).
  private units = 0;
  private batches = 0;

  private chatId?: string;
  private pageToken?: string;
  /** The latest publishedAt the source has processed (YouTube's clock only, CHAT-YT-037, CHAT-YT-060). */
  private newest?: number;
  /** True until the first response of the first tokenless session (CHAT-YT-034, CHAT-YT-061). */
  private historyPending = true;
  /** Set when the source leaves `reading`; the next response that resumes from a token is held to the 60 s rule (CHAT-YT-063). */
  private breakPending = false;
  private seen = new Set<string>();
  private opened = false;
  private streamAttempts = 0;
  private delay = BACKOFF_START_MS;
  private lastInterval = 0;
  private responses = 0;
  private firstCallLogged = false;

  constructor(opts: YouTubeSourceOptions) {
    this.videoId = opts.videoId;
    this.settings = opts.youtube;
    this.transport = opts.transport ?? createYouTubeTransport({ apiKey: opts.youtube.api_key.trim() });
    this.clock = opts.clock ?? systemClock;
  }

  state(): ChatSourceStatus {
    return { ...this.status };
  }

  async start(env: ChatSourceStartEnv): Promise<void> {
    this.env = env;
    this.scheduleTally();
    void this.run();
  }

  stop(): void {
    this.halt(undefined);
  }

  private async run(): Promise<void> {
    try {
      if (!(await this.resolve())) return;
      if (this.settings.transport === "stream" && !(await this.streamPhase())) return;
      await this.pollPhase();
    } catch (err) {
      this.halt(`unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** The lookup that decides the state (CHAT-YT-007..014, CHAT-YT-040, CHAT-YT-042, CHAT-YT-049). Resolves true with `chatId` set. */
  // @spec CHAT-YT-007, CHAT-YT-008, CHAT-YT-009, CHAT-YT-010, CHAT-YT-011, CHAT-YT-012, CHAT-YT-013, CHAT-YT-014, CHAT-YT-040, CHAT-YT-042, CHAT-YT-049, CHAT-YT-068
  private async resolve(): Promise<boolean> {
    for (;;) {
      if (this.stopped) return false;
      let item: LookupItem | undefined;
      this.spend(1);
      try {
        item = await this.transport.lookup(this.videoId, this.ac.signal);
      } catch (err) {
        if (this.stopped) return false;
        const failure = classify(err, "lookup");
        if (failure.kind === "quota") {
          this.setState("retrying", "quota");
          this.breakPending = true;
          await this.sleep(HOUR_MS);
          continue;
        }
        if (failure.kind === "keyRejected") { this.halt("the API key was rejected"); return false; }
        if (failure.kind === "auth") { this.halt("authentication failed"); return false; }
        if (failure.kind === "refused") { this.halt(failure.reason); return false; }
        this.setState("retrying");
        await this.sleep(this.nextDelay());
        continue;
      }
      if (this.stopped) return false;
      if (item === undefined) {
        this.halt(`video ${this.videoId} was not found (private, deleted or mistyped)`);
        return false;
      }
      if (item.liveBroadcastContent === "upcoming") {
        this.setState("waiting", "the broadcast has not started");
        await this.sleep(this.settings.recheck_ms);
        continue;
      }
      if (item.liveBroadcastContent === "live") {
        if (item.activeLiveChatId) {
          this.chatId = item.activeLiveChatId;
          // A recovery keeps `retrying` until a read delivers (CHAT-YT-044, CHAT-YT-045).
          if (this.status.state !== "retrying") this.setState("starting");
          return true;
        }
        this.halt("live chat is disabled for this broadcast");
        return false;
      }
      this.halt(item.actualEndTime ? "the broadcast has ended" : "the video is not a live broadcast");
      return false;
    }
  }

  /**
   * Reads by the server stream. Resolves true when the stream must fall back to polling (decided at start only,
   * CHAT-YT-019, CHAT-YT-020, CHAT-YT-021); resolves false when the source stopped.
   */
  // @spec CHAT-YT-015, CHAT-YT-016, CHAT-YT-017, CHAT-YT-018, CHAT-YT-019, CHAT-YT-020, CHAT-YT-021, CHAT-YT-022, CHAT-YT-023, CHAT-YT-030, CHAT-YT-046, CHAT-YT-048, CHAT-YT-062
  private async streamPhase(): Promise<boolean> {
    for (;;) {
      if (this.stopped) return false;
      const openToken = this.pageToken;
      let began = false;
      let failure: unknown;
      this.spend(5);
      this.noteFirstCall();
      const it = this.transport.openStream({ chatId: this.chatId!, pageToken: openToken, signal: this.ac.signal })[Symbol.asyncIterator]();
      try {
        for (;;) {
          const next = await it.next();
          if (this.stopped) return false;
          if (next.done) break;
          if (!began) { began = true; this.beginStream(); }
          if (next.value.type === "response") {
            this.batches += 1;
            this.pageToken = next.value.response.nextPageToken ?? this.pageToken;
            this.setState("reading");
            this.onResponse(next.value.response, openToken !== undefined);
            if (this.stopped) return false;
          }
        }
      } catch (err) {
        if (this.stopped) return false;
        failure = err;
      } finally {
        // Closes the call and releases its abort listener on every exit: end, failure, offlineAt, chatEndedEvent, stop.
        await it.return?.(undefined).catch(() => undefined);
      }

      if (failure === undefined) {
        // The server closed the stream.
        if (began) {
          this.setState("retrying");
          this.breakPending = true;
          await this.sleep(this.nextDelay());
          continue;
        }
        if (this.opened) { this.setState("retrying"); await this.sleep(this.nextDelay()); continue; }
        if (await this.failedOpen()) return true;
        continue;
      }

      const f = classify(failure, "stream");
      if (f.kind === "quota") {
        this.setState("retrying", "quota");
        this.breakPending = true;
        await this.sleep(HOUR_MS);
        if (!(await this.resolve())) return false;
        continue;
      }
      if (f.kind === "auth") { this.halt("authentication failed"); return false; }
      if (f.kind === "refused") { this.halt(f.reason); return false; }
      if (f.kind === "streamDenied" || f.kind === "unimplemented") {
        if (!this.opened) {
          this.env?.log.warn({ status: f.kind === "streamDenied" ? "PERMISSION_DENIED" : "UNIMPLEMENTED" }, "youtube stream refused, reading by polling");
          return true;
        }
        if (f.kind === "streamDenied") { this.halt("this chat refuses the API key"); return false; }
      } else if (f.kind === "chatGone" || f.kind === "chatNotFound") {
        this.setState("retrying");
        this.breakPending = true;
        await this.sleep(this.nextDelay());
        if (!(await this.resolve())) return false;
        continue;
      } else if (f.kind === "pageToken" && openToken !== undefined) {
        this.pageToken = undefined;
        continue;
      }
      if (!this.opened) {
        if (await this.failedOpen()) return true;
        continue;
      }
      this.setState("retrying");
      this.breakPending = true;
      await this.sleep(this.nextDelay());
    }
  }

  /** A stream open that ended with no response before the stream ever opened: counts toward the five attempts (CHAT-YT-019). */
  private async failedOpen(): Promise<boolean> {
    this.streamAttempts += 1;
    if (this.streamAttempts >= STREAM_ATTEMPTS_BEFORE_POLLING) {
      this.env?.log.warn({ attempts: this.streamAttempts }, "youtube stream did not open, reading by polling");
      return true;
    }
    this.setState("retrying");
    await this.sleep(this.nextDelay());
    return false;
  }

  private beginStream(): void {
    this.opened = true;
    this.streamAttempts = 0;
    this.resetBackoff();
    this.setState("reading");
  }

  /** Polling: the wait is the larger of the server's interval and the floor (CHAT-YT-027); reads resume from the token. */
  // @spec CHAT-YT-026, CHAT-YT-027, CHAT-YT-028, CHAT-YT-030, CHAT-YT-032, CHAT-YT-033, CHAT-YT-041, CHAT-YT-043, CHAT-YT-044, CHAT-YT-045, CHAT-YT-046, CHAT-YT-047, CHAT-YT-049, CHAT-YT-050
  private async pollPhase(): Promise<void> {
    for (;;) {
      if (this.stopped) return;
      const floor = this.settings.poll_floor_ms;
      const callToken = this.pageToken;
      const resumed = callToken !== undefined;
      let wait: number;
      try {
        this.spend(5);
        this.noteFirstCall();
        const r: LiveChatListResponse = await this.transport.poll({ chatId: this.chatId!, pageToken: callToken, signal: this.ac.signal });
        if (this.stopped) return;
        this.resetBackoff();
        this.setState("reading");
        this.pageToken = r.nextPageToken ?? this.pageToken;
        this.onResponse(r, resumed);
        if (this.stopped) return;
        this.lastInterval = r.pollingIntervalMillis ?? 0;
        wait = Math.max(floor, this.lastInterval);
      } catch (err) {
        if (this.stopped) return;
        const f = classify(err, "poll");
        if (f.kind === "auth") { this.halt("authentication failed"); return; }
        if (f.kind === "chatRefusesKey") { this.halt("this chat refuses the API key"); return; }
        if (f.kind === "refused") { this.halt(f.reason); return; }
        if (f.kind === "quota") {
          this.setState("retrying", "quota");
          this.breakPending = true;
          await this.sleep(HOUR_MS);
          if (!(await this.resolve())) return;
          wait = 0;
        } else if (f.kind === "chatGone" || f.kind === "chatNotFound") {
          this.setState("retrying");
          this.breakPending = true;
          const d = this.nextDelay();
          await this.sleep(d);
          if (!(await this.resolve())) return;
          wait = Math.max(floor, d);
        } else if (f.kind === "pageToken" && callToken !== undefined) {
          this.pageToken = undefined;
          wait = 0;
        } else if (f.kind === "rateLimit") {
          wait = 2 * Math.max(floor, this.lastInterval);
        } else {
          this.setState("retrying");
          this.breakPending = true;
          wait = Math.max(floor, this.nextDelay());
        }
      }
      await this.sleep(wait);
    }
  }

  /**
   * Applies one response: the first tokenless response is history (CHAT-YT-034, CHAT-YT-036); later ones publish what is
   * new, later than `newest` and, after a break, within 60 s of the response's newest (CHAT-YT-035, CHAT-YT-063..065).
   * Removal markers are reported once, unless the same response holds a message they cover (CHAT-YT-066, CHAT-YT-067).
   */
  // @spec CHAT-YT-034, CHAT-YT-035, CHAT-YT-036, CHAT-YT-037, CHAT-YT-038, CHAT-YT-050, CHAT-YT-056, CHAT-YT-060, CHAT-YT-061, CHAT-YT-063, CHAT-YT-064, CHAT-YT-065, CHAT-YT-066, CHAT-YT-067, CHAT-FORGET-002, CHAT-FORGET-003, CHAT-FORGET-004, CHAT-FORGET-005
  private onResponse(r: LiveChatListResponse, resumed: boolean): void {
    const items = (r.items ?? []) as LiveChatItem[];
    this.responses += 1;
    if (this.responses <= 3) this.env?.log.info({ items: items.length }, "youtube first responses");
    const applyWindow = this.breakPending && resumed;
    this.breakPending = false;
    const history = this.historyPending && items.length > 0;
    this.historyPending = false;

    const latest = items.reduce<number | undefined>((best, item) => {
      const t = millis((item.snippet as Record<string, unknown> | undefined)?.publishedAt);
      return t === undefined ? best : best === undefined || t > best ? t : best;
    }, undefined);
    const before = this.newest;
    const windowFloor = applyWindow && latest !== undefined ? latest - WINDOW_MS : undefined;
    const dropWhole = applyWindow && latest === undefined;

    const mapped = items.map((item) => ({ item, m: mapLiveChatItem(item) }));
    const messageIds = new Set<string>();
    const messageAuthors = new Set<string>();
    for (const { m } of mapped) {
      if (m.kind !== "message") continue;
      messageIds.add(m.messageId);
      if (m.sender.userId) messageAuthors.add(m.sender.userId);
    }
    // A marker covers the messages of this response it names; a message covered by one of them is suppressed with it.
    const coveredMessageIds = new Set<string>();
    const coveredAuthors = new Set<string>();
    const coveredRemovals = new Set<ChatRemoval>();
    for (const { m } of mapped) {
      if (m.kind !== "removal") continue;
      if (m.removal.scope === "message" && m.removal.messageId !== undefined && messageIds.has(m.removal.messageId)) {
        coveredMessageIds.add(m.removal.messageId);
        coveredRemovals.add(m.removal);
      }
      // A user removal (ban or timeout) suppresses its author's messages in this response but is still published.
      if (m.removal.scope === "user" && m.removal.userId !== undefined && messageAuthors.has(m.removal.userId)) {
        coveredAuthors.add(m.removal.userId);
      }
    }

    let ended = false;
    for (const { item, m } of mapped) {
      if (this.stopped) return;
      switch (m.kind) {
        case "message": {
          const fresh = this.remember(m.messageId);
          if (!fresh || history || dropWhole) break;
          const ts = millis(item.snippet?.publishedAt);
          if (windowFloor !== undefined && ts !== undefined && ts < windowFloor) break;
          if (ts !== undefined && before !== undefined && ts <= before) break;
          if (coveredMessageIds.has(m.messageId) || (m.sender.userId !== undefined && coveredAuthors.has(m.sender.userId))) break;
          this.env?.emit(m.sender, m.text, m.messageId);
          break;
        }
        case "removal": {
          const fresh = this.remember(m.markerId);
          if (!fresh || history || dropWhole || coveredRemovals.has(m.removal)) break;
          this.env?.emitRemoval(m.removal);
          break;
        }
        case "unusable":
          this.env?.log.warn({ type: m.type }, "youtube removal marker has no usable id, nothing forgotten");
          break;
        case "notice":
          this.env?.log.info({ notice: m.notice }, "youtube sponsor-only mode changed, not chat");
          break;
        case "ended":
          ended = true;
          break;
        default:
          break;
      }
    }
    this.newest = latest ?? before;
    if (ended || r.offlineAt) this.halt("the broadcast has ended");
  }

  /** Records an id; false when it was already in the window of the last 2,000 (CHAT-YT-038). */
  private remember(id: string): boolean {
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    if (this.seen.size > SEEN_LIMIT) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return true;
  }

  private setState(state: ChatSourceState, reason?: string): void {
    if (this.stopped && state !== "stopped") return;
    const changed = this.status.state !== state || this.status.reason !== reason;
    this.status = reason === undefined ? { state } : { state, reason };
    if (!changed) return;
    this.env?.onState(state, reason);
    this.logTally();
  }

  /** Stops the source for good: state, one error line with the reason, every timer and call cancelled (CHAT-YT-014, CHAT-SRC-005). */
  private halt(reason: string | undefined): void {
    if (this.stopped) return;
    this.setState("stopped", reason);
    this.stopped = true;
    if (reason !== undefined) this.env?.log.error({ reason }, "youtube source stopped");
    if (this.tallyTimer !== undefined) this.clock.clearTimeout(this.tallyTimer);
    this.tallyTimer = undefined;
    for (const wake of [...this.wakers]) wake();
    this.wakers = new Set<() => void>();
    this.ac.abort();
  }

  private spend(units: number): void {
    this.units += units;
  }

  /** The first read call of a start logs the tally once, so a new source's first line is current (CHAT-YT-030). */
  private noteFirstCall(): void {
    if (this.firstCallLogged) return;
    this.firstCallLogged = true;
    this.logTally();
  }

  private logTally(): void {
    this.env?.log.info({ units: this.units, batches: this.batches }, "youtube quota tally");
  }

  private scheduleTally(): void {
    this.tallyTimer = this.clock.setTimeout(() => {
      this.tallyTimer = undefined;
      if (this.stopped) return;
      this.logTally();
      this.scheduleTally();
    }, TALLY_MS);
  }

  /** A wait on the injected clock that ends early when the source stops. */
  private sleep(ms: number): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let handle: unknown;
      const wake = () => {
        this.clock.clearTimeout(handle);
        this.wakers.delete(wake);
        resolve();
      };
      handle = this.clock.setTimeout(() => { this.wakers.delete(wake); resolve(); }, ms);
      this.wakers.add(wake);
    });
  }

  /** The backoff: 1 s doubling to 60 s (CHAT-YT-018, CHAT-YT-049). */
  private nextDelay(): number {
    const d = this.delay;
    this.delay = Math.min(this.delay * 2, BACKOFF_CAP_MS);
    return d;
  }

  private resetBackoff(): void {
    this.delay = BACKOFF_START_MS;
  }
}
