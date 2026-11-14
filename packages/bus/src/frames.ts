/**
 * The frames path's transport: audio frames on ioredis (event-bus design, "Frames path"). The only file that imports
 * ioredis (BUS-NAT-API-003) and it never touches the native addon (BUS-NAT-FRM-007). Frames are small and frequent, so
 * crossing into the addon once per frame costs more than native Redis I/O saves; the facade's `publishFrame` and
 * `tailAudio` run on this transport. Stream layout and frame format: connections CONN-AUD-*, CONN-BP-*.
 */
import { Redis, type RedisOptions } from "ioredis";
import {
  AUDIO_MAXLEN, AUDIO_STREAM_TTL_MS, decodeFrame, encodeFrame, type AudioDirection, type Frame,
} from "./connector.js";
import type { BusErrorCode, FrameEntry, FrameReader, FrameTransport, FrameTransportFactory } from "./transport.js";

/** Longest a connect attempt may take before it counts as failed (BUS-NAT-FRM-006). */
const CONNECT_TIMEOUT_MS = 10_000;
const RECONNECT_BASE_MS = 250;
const RECONNECT_MAX_MS = 30_000;
const CODES = new Set<string>(["BUS_CONNECTION", "BUS_REDIS", "BUS_CLOSED", "BUS_INVALID", "BUS_INTERNAL"]);

/** `<prefix>:audio.<dir>.<tag>` (BUS-AUD-001, BUS-NAT-RS-006). */
export const audioStreamName = (prefix: string, dir: AudioDirection, tag: string): string => `${prefix}:audio.${dir}.${tag}`;

const coded = (code: BusErrorCode, message: string, cause?: unknown): Error & { code: BusErrorCode } =>
  Object.assign(new Error(message, { cause }), { code });

/** The error a caller sees: Redis's own refusal is `BUS_REDIS`, everything else the connection raised is `BUS_CONNECTION`. */
function toBusError(err: unknown, lastConnectError?: Error): Error & { code: BusErrorCode } {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && CODES.has(code)) return err as Error & { code: BusErrorCode };
  const e = err instanceof Error ? err : new Error(String(err));
  if (e.name === "ReplyError") return coded("BUS_REDIS", e.message, e);
  // ioredis says only "Connection is closed." for a reset; the underlying cause is the last connect error it emitted
  const cause = lastConnectError && /closed|end/i.test(e.message) ? lastConnectError.message : e.message;
  return coded("BUS_CONNECTION", cause, e);
}

/** Connection options shared by the publish connection and the readers. */
function baseOptions(failFast: boolean): RedisOptions {
  return {
    lazyConnect: true,
    connectTimeout: CONNECT_TIMEOUT_MS,
    // failFast: never reconnect; otherwise 250 ms doubling to 30 s (BUS-NAT-FRM-006)
    retryStrategy: failFast ? () => null : (times) => Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(times - 1, 30)),
  };
}

/** A connection that is silent: errors are surfaced as rejections, never printed (BUS-NAT-FRM-006). */
function open(url: string, opts: RedisOptions): { redis: Redis; lastError: () => Error | undefined } {
  const redis = new Redis(url, opts);
  let last: Error | undefined;
  redis.on("error", (err: Error) => { last = err; });
  return { redis, lastError: () => last };
}

/**
 * One publish connection per `Bus`, opened at the first `appendFrame`, with no offline queue: the first call waits for the
 * first connect attempt, and while the connection is down afterwards a call rejects at once (CONN-BP-001: a frame that
 * cannot go out now is stale by the time Redis returns).
 */
// @spec BUS-NAT-FRM-003, BUS-NAT-FRM-005, BUS-NAT-FRM-006, BUS-NAT-ERR-005
class IoredisFrameTransport implements FrameTransport {
  private conn?: { redis: Redis; lastError: () => Error | undefined };
  private first?: Promise<unknown>;
  private closed = false;
  private readers = new Set<IoredisFrameReader>();
  private closing?: Promise<void>;
  /** Settles when `close()` runs, so a call waiting on the first connect attempt does not outlive the transport. */
  private signalClosed: () => void = () => {};
  private readonly closedSignal = new Promise<Error>((resolve) => { this.signalClosed = () => resolve(coded("BUS_CLOSED", "transport closed")); });

  constructor(private readonly url: string, private readonly prefix: string, private readonly failFast: boolean) {}

  async appendFrame(dir: AudioDirection, tag: string, frame: Frame): Promise<string> {
    if (this.closed) throw coded("BUS_CLOSED", "transport closed");
    if (!this.conn) {
      this.conn = open(this.url, { ...baseOptions(this.failFast), enableOfflineQueue: false, maxRetriesPerRequest: 0 });
      this.first = Promise.race([this.conn.redis.connect().then(() => undefined, (e: unknown) => e), this.closedSignal]);
    }
    const { redis, lastError } = this.conn;
    // Every call awaits the first attempt's outcome, resolved or not, so frames keep their call order (BUS-NAT-FRM-005).
    const firstError = await this.first;
    if (this.closed) throw coded("BUS_CLOSED", "transport closed");
    if (redis.status !== "ready") throw toBusError(firstError ?? lastError() ?? new Error("connection down"), lastError());
    const key = audioStreamName(this.prefix, dir, tag);
    let results: [Error | null, unknown][] | null;
    try {
      results = await redis.pipeline()
        .xadd(key, "MAXLEN", "~", AUDIO_MAXLEN[dir], "*", ...encodeFrame(frame))
        .pexpire(key, AUDIO_STREAM_TTL_MS)
        .exec();
    } catch (err) {
      throw this.closed ? coded("BUS_CLOSED", "transport closed") : toBusError(err, lastError());
    }
    for (const [err] of results ?? []) if (err) throw this.closed ? coded("BUS_CLOSED", "transport closed") : toBusError(err, lastError());
    return String(results![0]![1]);
  }

  openReader(): FrameReader {
    if (this.closed) throw coded("BUS_CLOSED", "transport closed");
    const r = new IoredisFrameReader(this.url, this.prefix, this.failFast, () => this.readers.delete(r));
    this.readers.add(r);
    return r;
  }

  close(): Promise<void> {
    if (!this.closing) {
      this.closed = true;
      this.signalClosed();
      this.conn?.redis.disconnect();
      for (const r of [...this.readers]) r.close();
      this.closing = Promise.resolve();
    }
    return this.closing;
  }
}

// @spec BUS-NAT-FRM-004, BUS-NAT-FRM-005, CONN-BP-002, CONN-BP-006
class IoredisFrameReader implements FrameReader {
  private conn?: { redis: Redis; lastError: () => Error | undefined };
  private closed = false;

  constructor(private readonly url: string, private readonly prefix: string, private readonly failFast: boolean, private readonly onClose: () => void) {}

  async readFrames(dir: AudioDirection, tag: string, fromId: string, count: number, blockMs: number): Promise<FrameEntry[] | null> {
    if (this.closed) throw coded("BUS_CLOSED", "reader closed");
    // A blocked read waits out a reconnect instead of failing (maxRetriesPerRequest null) and resumes from `fromId`.
    this.conn ??= open(this.url, { ...baseOptions(this.failFast), maxRetriesPerRequest: null });
    const { redis, lastError } = this.conn;
    let res: [Buffer | string, [Buffer | string, (Buffer | string)[]][]][] | null;
    try {
      res = (await redis.xreadBuffer("COUNT", count, "BLOCK", blockMs, "STREAMS", audioStreamName(this.prefix, dir, tag), fromId)) as typeof res;
    } catch (err) {
      throw this.closed ? coded("BUS_CLOSED", "reader closed") : toBusError(err, lastError());
    }
    if (!res) return null;
    return (res[0]?.[1] ?? []).map(([id, fields]) => ({ id: id.toString(), decoded: decodeFrame(fields) }));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.conn?.redis.disconnect();
    this.onClose();
  }
}

/** Production default of `BusOptions.frames` (BUS-NAT-FRM-007). Opens nothing until the first `appendFrame` or read. */
export const createFrameTransport: FrameTransportFactory = (url, opts) => new IoredisFrameTransport(url, opts.prefix, opts.failFast);
