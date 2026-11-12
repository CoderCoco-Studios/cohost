import { Redis, type RedisOptions } from "ioredis";
import { randomUUID } from "node:crypto";
import { urls, type Logger } from "@cohost/config";
import { EventPayloads, type BusEvent, type EventInput, type EventType } from "./events.js";

import {
  AUDIO_MAXLEN, AUDIO_STREAM_TTL_MS, LEASE_INTERVALS, encodeFrame, decodeFrame, parseRegistration,
  type AudioDirection, type DecodedFrame, type Frame, type Registration,
} from "./connector.js";

export * from "./events.js";
export * from "./connector.js";
export * from "./registrar.js";

export const STREAM = "cohost:events";
const MAXLEN = 20_000;
/** Heartbeats live on their own capped stream so they never evict domain events. */
export const HEALTH_STREAM = "cohost:health";
export const HEALTH_MAXLEN = 1000;

export type HeartbeatEvent = BusEvent<"service.heartbeat">;

/** How `subscribe` positions its consumer group on start. */
export type SubscribeStart = "latest" | "resume";

export interface SubscribeOptions<T extends EventType> {
  /** Consumer group — one per service. */
  group: string;
  /** Only deliver these types (others are acked and skipped). */
  types?: readonly T[];
  /**
   * Where the group starts, named by every caller. `latest` moves the group to the newest entry on
   * every start; `resume` keeps an existing group's stored position. A missing group is created at `$` in both.
   */
  start: SubscribeStart;
  /** Block time per read, ms. */
  blockMs?: number;
  /** Called once the consumer group exists and is positioned, before the first read. */
  onReady?: () => void;
}

export type Handler<T extends EventType> = (event: BusEvent<T>) => void | Promise<void>;

/** The slice of an ioredis connection that `Bus` uses; `BusOptions.connect` may return a fake. */
export type BusRedis = Pick<Redis, "xadd" | "xgroup" | "xreadgroup" | "xack" | "xread" | "xrevrange" | "time" | "set" | "getdelBuffer" | "get" | "del" | "mget" | "scan" | "pexpire" | "xreadBuffer" | "disconnect">;

/** Optional construction hooks, additive to `(source, log?, url?)`. Production defaults need none of them. */
export interface BusOptions {
  /** Build a Redis connection (default: `new Redis(url, opts)`). Tests inject fakes here. */
  connect?: (url: string, opts: RedisOptions) => BusRedis;
  /** First retry delay after a failed read, ms (default 250; doubles per consecutive failure). */
  retryBaseMs?: number;
  /** Cap on the retry delay, ms (default 30000). */
  retryMaxMs?: number;
  /** Stream key prefix: the instance uses `<prefix>:events` and `<prefix>:health` (default `cohost`). Tests use their own. */
  streamPrefix?: string;
  /** Do not reconnect: an unreachable Redis rejects the first command at once and prints nothing (BUS-STREAM-009). For short-lived CLIs. */
  failFast?: boolean;
}

/** Called after each blocking read of a tail loop: no argument on success (an empty read counts), the error on failure. */
export type ReadOutcome = (err?: unknown) => void;
const report = (cb: ReadOutcome | undefined, err?: unknown): void => {
  try { if (err === undefined) cb?.(); else cb?.(err ?? new Error("read failed")); } catch { /* a reporting callback must not stop the loop */ }
};

const DEFAULT_PREFIX = "cohost";
const RETRY_BASE_MS = 250;
const RETRY_MAX_MS = 30_000;

/** The publishing half of a Bus: what region logic depends on, so tests can pass a recorder. */
export type Publisher = Pick<Bus, "publish">;

/**
 * Thin typed wrapper over one Redis Stream. Publish is fire-and-forget;
 * subscribe runs a consumer-group loop until stop().
 */
// @spec BUS-STREAM-005
export class Bus {
  private pub: BusRedis;
  private subs: BusRedis[] = [];
  private stopped = false;
  readonly consumer = `${process.env.HOSTNAME ?? "local"}-${randomUUID().slice(0, 8)}`;

  private connect: (url: string, opts: RedisOptions) => BusRedis;
  private retryBaseMs: number;
  private retryMaxMs: number;
  private wake = new Set<() => void>();
  /** The domain-event stream and the heartbeat stream of this instance (BUS-STREAM-008). */
  private readonly stream: string;
  private readonly healthStream: string;
  /** Prefix of the upload keys, `<prefix>:upload:<id>` (BUS-UPL-001). */
  private readonly uploadPrefix: string;
  /** Prefix of the connector keys and audio streams (BUS-AUD-001, BUS-AUD-002). */
  private readonly prefix: string;

  constructor(private source: string, private log?: Logger, private url = urls.redis(), options: BusOptions = {}) {
    this.connect = options.connect ?? ((u, o) => new Redis(u, o));
    this.retryBaseMs = options.retryBaseMs ?? RETRY_BASE_MS;
    this.retryMaxMs = options.retryMaxMs ?? RETRY_MAX_MS;
    const prefix = options.streamPrefix ?? DEFAULT_PREFIX;
    this.stream = `${prefix}:events`;
    this.healthStream = `${prefix}:health`;
    this.uploadPrefix = `${prefix}:upload:`;
    this.prefix = prefix;
    this.pub = this.connect(url, { lazyConnect: false, maxRetriesPerRequest: 3, ...(options.failFast ? { retryStrategy: () => null } : {}) });
    // @spec BUS-STREAM-009
    if (options.failFast) (this.pub as { on?: (ev: string, fn: () => void) => unknown }).on?.("error", () => {});
  }

  // @spec BUS-STREAM-001, BUS-STREAM-002, BUS-STREAM-003, BUS-STREAM-004, BUS-STREAM-007
  async publish<T extends EventType>(type: T, data: EventInput<T>): Promise<string> {
    if (type === "service.heartbeat") throw new Error("service.heartbeat goes on the health stream: use publishHealth()");
    const parsed = EventPayloads[type].parse(data);
    let id: string | null;
    try {
      id = await this.pub.xadd(
        this.stream, "MAXLEN", "~", MAXLEN, "*",
        "type", type,
        "ts", String(Date.now()),
        "source", this.source,
        "data", JSON.stringify(parsed),
      );
    } catch (err) {
      this.log?.warn({ err, type }, "publish failed");
      throw err;
    }
    this.log?.debug({ type, id }, "published");
    return id as string;
  }

  /** Store an injected test upload under `<prefix>:upload:<id>`, expiring after `ttlMs`. Not a stream entry. */
  // @spec BUS-UPL-001, BUS-UPL-003
  async putUpload(id: string, bytes: Buffer, ttlMs: number): Promise<void> {
    await this.pub.set(this.uploadPrefix + id, bytes, "PX", ttlMs);
  }

  /** Read and delete an upload in one step; `null` when it does not exist or has expired. */
  // @spec BUS-UPL-002
  async takeUpload(id: string): Promise<Buffer | null> {
    return await this.pub.getdelBuffer(this.uploadPrefix + id);
  }

  /** The key of a connector's registration, `<prefix>:connector:<id>` (BUS-AUD-002). */
  connectorKey(id: string): string { return `${this.prefix}:connector:${id}`; }

  /** The stream of a source (`in`) or sink (`out`), `<prefix>:audio.<dir>.<tag>` (BUS-AUD-001). */
  audioStream(dir: AudioDirection, tag: string): string { return `${this.prefix}:audio.${dir}.${tag}`; }

  /** Write a registration under its key with a lease of three intervals; not a stream entry. */
  // @spec CONN-REG-001, CONN-REG-002, BUS-AUD-002
  async writeRegistration(reg: Registration): Promise<void> {
    await this.pub.set(this.connectorKey(reg.id), JSON.stringify(reg), "PX", reg.intervalMs * LEASE_INTERVALS);
  }

  /** The live registration of `id`, or `undefined`. */
  async readRegistration(id: string): Promise<Registration | undefined> {
    return parseRegistration(await this.pub.get(this.connectorKey(id)));
  }

  /** Delete the registration of `id` (orderly shutdown). */
  // @spec CONN-REG-003
  async deleteRegistration(id: string): Promise<void> {
    await this.pub.del(this.connectorKey(id));
  }

  /** Every live registration: `SCAN <prefix>:connector:*` then one read. Invalid values are skipped. */
  // @spec CONN-REG-006, BUS-AUD-002
  async listConnectors(): Promise<Registration[]> {
    const keys: string[] = [];
    let cursor = "0";
    do {
      const [next, batch] = (await this.pub.scan(cursor, "MATCH", `${this.prefix}:connector:*`, "COUNT", 100)) as [string, string[]];
      keys.push(...batch);
      cursor = next;
    } while (cursor !== "0");
    if (keys.length === 0) return [];
    const uniq = [...new Set(keys)];
    const values = (await this.pub.mget(...uniq)) as (string | null)[];
    return values.flatMap((v) => { const r = parseRegistration(v); return r ? [r] : []; });
  }

  /**
   * Append one audio frame to `audio.<dir>.<tag>` with `MAXLEN ~` of the direction's cap and refresh the stream's 60 s
   * expiry. Never waits for a consumer (CONN-BP-001); `publish` neither writes nor trims these streams (BUS-AUD-001).
   */
  // @spec CONN-AUD-001, CONN-BP-001, BUS-AUD-001
  async publishFrame(dir: AudioDirection, tag: string, frame: Frame): Promise<string> {
    const key = this.audioStream(dir, tag);
    const id = (await this.pub.xadd(key, "MAXLEN", "~", AUDIO_MAXLEN[dir], "*", ...encodeFrame(frame))) as string;
    await this.pub.pexpire(key, AUDIO_STREAM_TTL_MS);
    return id;
  }

  /**
   * Live read of `audio.<dir>.<tag>`: plain blocking `XREAD` from the end (`$`), no group, no acknowledgement, no replay
   * (CONN-BP-002). Resolves when `stop()` is called. A handler throw is logged and the loop continues.
   */
  // @spec CONN-BP-002, BUS-AUD-001
  async tailAudio(dir: AudioDirection, tag: string, handler: (decoded: DecodedFrame, id: string) => void, onRead?: ReadOutcome): Promise<void> {
    const conn = this.connect(this.url, { maxRetriesPerRequest: null });
    this.subs.push(conn);
    const key = this.audioStream(dir, tag);
    let last = "$";
    let failures = 0;
    while (!this.stopped) {
      let res: [Buffer | string, [Buffer | string, (Buffer | string)[]][]][] | null;
      try {
        res = (await conn.xreadBuffer("COUNT", 100, "BLOCK", 5000, "STREAMS", key, last)) as typeof res;
      } catch (err) {
        if (this.stopped) break;
        report(onRead, err ?? new Error("read failed"));
        await this.backoff(err, ++failures, "tailAudio read failed");
        continue;
      }
      failures = 0;
      report(onRead);
      if (!res) continue;
      for (const [rawId, fields] of res[0]?.[1] ?? []) {
        const id = rawId.toString();
        last = id;
        this.guard(() => handler(decodeFrame(fields), id), `audio.${dir}.${tag}`, id);
      }
    }
    conn.disconnect();
  }

  /** Publish a heartbeat to `cohost:health` (validated; never touches `cohost:events`). */
  // @spec BUS-HEALTH-001, BUS-HEALTH-002, BUS-STREAM-007
  async publishHealth(data: EventInput<"service.heartbeat">): Promise<string> {
    const parsed = EventPayloads["service.heartbeat"].parse(data);
    try {
      return (await this.pub.xadd(
        this.healthStream, "MAXLEN", "~", HEALTH_MAXLEN, "*",
        "type", "service.heartbeat",
        "ts", String(Date.now()),
        "source", this.source,
        "data", JSON.stringify(parsed),
      )) as string;
    } catch (err) {
      this.log?.warn({ err, type: "service.heartbeat" }, "publish failed");
      throw err;
    }
  }

  /** Non-group live tail of the health stream. Does not ack. `onRead` hears each read's outcome (BUS-TAIL-005). */
  // @spec BUS-HEALTH-003, BUS-TAIL-003, BUS-TAIL-004, BUS-TAIL-005
  async tailHealth(handler: (hb: HeartbeatEvent) => void, fromId = "$", onRead?: ReadOutcome): Promise<void> {
    const conn = this.connect(this.url, { maxRetriesPerRequest: null });
    this.subs.push(conn);
    let last = fromId;
    let failures = 0;
    while (!this.stopped) {
      let res: [string, [string, string[]][]][] | null;
      try {
        res = (await conn.xread("COUNT", 100, "BLOCK", 5000, "STREAMS", this.healthStream, last)) as typeof res;
      } catch (err) {
        if (this.stopped) break;
        report(onRead, err ?? new Error("read failed"));
        await this.backoff(err, ++failures, "tailHealth read failed");
        continue;
      }
      failures = 0;
      report(onRead);
      if (!res) continue;
      for (const [id, fields] of res[0]?.[1] ?? []) {
        last = id;
        const ev = decode(id, fields);
        if (ev?.type === "service.heartbeat") this.guard(() => handler(ev as HeartbeatEvent), ev.type, id);
      }
    }
    conn.disconnect();
  }

  /** The Redis server's clock in ms (`TIME`): one reference for every observer, whatever its own clock says. */
  // @spec CTRL-CHECK-004
  async serverTime(): Promise<number> {
    const [secs, micros] = await this.pub.time();
    return Number(secs) * 1000 + Math.floor(Number(micros) / 1000);
  }

  /** Newest N heartbeats, oldest first. */
  // @spec BUS-HEALTH-004
  async recentHealth(count = 100): Promise<HeartbeatEvent[]> {
    const rows = (await this.pub.xrevrange(this.healthStream, "+", "-", "COUNT", count)) as [string, string[]][];
    return rows
      .map(([id, f]) => decode(id, f))
      .filter((e): e is HeartbeatEvent => e?.type === "service.heartbeat")
      .reverse();
  }

  /**
   * Point a consumer group at the stream's newest entry (`XGROUP SETID <group> $`), creating the
   * group (and stream) at `$` if it does not exist. Used for "fresh" service starts.
   *
   * Creates first (`XGROUP CREATE ... $ MKSTREAM`) and only falls back to `SETID` on `BUSYGROUP`:
   * on a fresh Redis 7+ the stream key does not exist and `SETID` answers "ERR The XGROUP
   * subcommand requires the key to exist", an error that is not `NOGROUP`, so SETID-first would
   * have to match Redis-version-specific error text. A `BUSYGROUP` from a concurrent creator is
   * the same "group exists" case and also ends in `SETID`.
   */
  // @spec BUS-GROUP-001
  async resetGroup(group: string): Promise<void> {
    try {
      await this.pub.xgroup("CREATE", this.stream, group, "$", "MKSTREAM");
    } catch (e) {
      if (!String(e).includes("BUSYGROUP")) throw e;
      await this.pub.xgroup("SETID", this.stream, group, "$");
    }
  }

  /** Consumer-group subscription. Resolves when stop() is called. */
  // @spec BUS-SUB-001, BUS-SUB-002, BUS-SUB-003, BUS-SUB-004, BUS-SUB-005, BUS-SUB-006, BUS-SUB-009, BUS-SUB-010, BUS-SUB-011, BUS-SUB-012, BUS-SUB-013
  async subscribe<T extends EventType>(opts: SubscribeOptions<T>, handler: Handler<T>): Promise<void> {
    const mode = opts.start as unknown;
    if (mode !== "latest" && mode !== "resume") {
      throw new Error(`Bus.subscribe: start must be "latest" or "resume", got ${JSON.stringify(mode)}`);
    }
    const conn = this.connect(this.url, { maxRetriesPerRequest: null });
    this.subs.push(conn);
    try {
      await conn.xgroup("CREATE", this.stream, opts.group, "$", "MKSTREAM");
    } catch (e) {
      if (!String(e).includes("BUSYGROUP")) throw e;
      if (mode === "latest") await conn.xgroup("SETID", this.stream, opts.group, "$");
    }
    opts.onReady?.();
    const wanted = opts.types ? new Set<string>(opts.types) : undefined;
    const block = opts.blockMs ?? 5000;

    // First drain this consumer's own pending entries, a batch at a time from the last id seen (so an entry that
    // stays pending, for instance after a failed XACK, cannot hold the drain), then read new ones. A restarted
    // process has a new consumer name, so entries its predecessor left pending are not redelivered.
    let cursor: string = "0";
    let failures = 0;
    while (!this.stopped) {
      let res: [string, [string, string[]][]][] | null;
      try {
        res = (await conn.xreadgroup(
          "GROUP", opts.group, this.consumer, "COUNT", 50, "BLOCK", block, "STREAMS", this.stream, cursor,
        )) as typeof res;
      } catch (err) {
        if (this.stopped) break; // stop() closed the connection under a blocking read
        await this.backoff(err, ++failures, "subscribe read failed");
        continue;
      }
      failures = 0;
      if (!res) { cursor = ">"; continue; }
      const entries = res[0]?.[1] ?? [];
      if (cursor !== ">" && entries.length === 0) { cursor = ">"; continue; }
      for (const [id, fields] of entries) {
        if (this.stopped) break; // stop() landed during the previous handler: nothing further is handled or acked
        const ev = decode(id, fields);
        if (ev && (!wanted || wanted.has(ev.type))) {
          try {
            await handler(ev as BusEvent<T>);
          } catch (err) {
            this.log?.error({ err, type: ev.type, id }, "handler failed");
          }
        }
        if (this.stopped) break; // the connection is closed: no XACK after stop
        try {
          await conn.xack(this.stream, opts.group, id);
        } catch (err) {
          this.log?.warn({ err, id }, "ack failed"); // at-most-once: the handled entry is not redelivered
        }
        if (cursor !== ">") cursor = id;
      }
    }
    conn.disconnect();
  }

  /** Non-group live tail (dashboard). Does not ack, does not replay. `onRead` hears each read's outcome (BUS-TAIL-005). */
  // @spec BUS-TAIL-001, BUS-TAIL-003, BUS-TAIL-004, BUS-TAIL-005
  async tail(handler: (ev: BusEvent) => void, fromId = "$", onRead?: ReadOutcome): Promise<void> {
    const conn = this.connect(this.url, { maxRetriesPerRequest: null });
    this.subs.push(conn);
    let last = fromId;
    let failures = 0;
    while (!this.stopped) {
      let res: [string, [string, string[]][]][] | null;
      try {
        res = (await conn.xread("COUNT", 100, "BLOCK", 5000, "STREAMS", this.stream, last)) as typeof res;
      } catch (err) {
        if (this.stopped) break;
        report(onRead, err ?? new Error("read failed"));
        await this.backoff(err, ++failures, "tail read failed");
        continue;
      }
      failures = 0;
      report(onRead);
      if (!res) continue;
      for (const [id, fields] of res[0]?.[1] ?? []) {
        last = id;
        const ev = decode(id, fields);
        if (ev) this.guard(() => handler(ev), ev.type, id);
      }
    }
    conn.disconnect();
  }

  /** Most recent N events (dashboard backfill). */
  // @spec BUS-TAIL-002
  async recent(count = 100): Promise<BusEvent[]> {
    const rows = (await this.pub.xrevrange(this.stream, "+", "-", "COUNT", count)) as [string, string[]][];
    return rows.map(([id, f]) => decode(id, f)).filter((e): e is BusEvent => !!e).reverse();
  }

  /** Log a failed read and sleep for the capped exponential delay; `stop()` ends the sleep early. */
  private async backoff(err: unknown, failures: number, msg: string): Promise<void> {
    const delayMs = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** Math.min(failures - 1, 30));
    this.log?.warn({ err, delayMs, failures }, msg);
    if (this.stopped) return;
    await new Promise<void>((resolve) => {
      const done = () => { clearTimeout(timer); this.wake.delete(done); resolve(); };
      const timer = setTimeout(done, delayMs);
      this.wake.add(done);
    });
  }

  /** Run a tail handler so that a throw (or rejection) is logged and the loop keeps going. */
  private guard(fn: () => unknown, type: string, id: string): void {
    const fail = (err: unknown) => this.log?.error({ err, type, id }, "handler failed");
    try {
      const r = fn();
      if (r instanceof Promise) r.catch(fail);
    } catch (err) { fail(err); }
  }

  // @spec BUS-STOP-001
  stop(): void {
    this.stopped = true;
    for (const w of [...this.wake]) w();
    for (const c of this.subs) c.disconnect();
    this.pub.disconnect();
  }
}

// @spec BUS-STREAM-006, BUS-SUB-007
function decode(id: string, fields: string[]): BusEvent | undefined {
  const m: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) m[fields[i]!] = fields[i + 1]!;
  const type = m.type as EventType | undefined;
  if (!type || !(type in EventPayloads)) return undefined;
  try {
    return {
      id,
      type,
      ts: Number(m.ts ?? 0),
      source: m.source ?? "?",
      data: EventPayloads[type].parse(JSON.parse(m.data ?? "{}")) as never,
    };
  } catch {
    return undefined;
  }
}
