import { Redis, type RedisOptions } from "ioredis";
import { randomUUID } from "node:crypto";
import { urls, type Logger } from "@cohost/config";
import { EventPayloads, type BusEvent, type EventInput, type EventType } from "./events.js";

export * from "./events.js";

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
   * Where the group starts. `latest` (default) moves the group to the newest entry on every start;
   * `resume` keeps an existing group's stored position. A missing group is created at `$` in both.
   */
  start?: SubscribeStart;
  /** @deprecated Ignored: a missing group is always created at `$`. Name `start` instead. */
  fromNow?: boolean;
  /** Block time per read, ms. */
  blockMs?: number;
}

export type Handler<T extends EventType> = (event: BusEvent<T>) => void | Promise<void>;

/** The slice of an ioredis connection that `Bus` uses; `BusOptions.connect` may return a fake. */
export type BusRedis = Pick<Redis, "xadd" | "xgroup" | "xreadgroup" | "xack" | "xread" | "xrevrange" | "disconnect">;

/** Optional construction hooks, additive to `(source, log?, url?)`. Production defaults need none of them. */
export interface BusOptions {
  /** Build a Redis connection (default: `new Redis(url, opts)`). Tests inject fakes here. */
  connect?: (url: string, opts: RedisOptions) => BusRedis;
  /** First retry delay after a failed read, ms (default 250; doubles per consecutive failure). */
  retryBaseMs?: number;
  /** Cap on the retry delay, ms (default 30000). */
  retryMaxMs?: number;
}

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

  constructor(private source: string, private log?: Logger, private url = urls.redis(), options: BusOptions = {}) {
    this.connect = options.connect ?? ((u, o) => new Redis(u, o));
    this.retryBaseMs = options.retryBaseMs ?? RETRY_BASE_MS;
    this.retryMaxMs = options.retryMaxMs ?? RETRY_MAX_MS;
    this.pub = this.connect(url, { lazyConnect: false, maxRetriesPerRequest: 3 });
  }

  // @spec BUS-STREAM-001, BUS-STREAM-002, BUS-STREAM-003, BUS-STREAM-004, BUS-STREAM-007
  async publish<T extends EventType>(type: T, data: EventInput<T>): Promise<string> {
    if (type === "service.heartbeat") throw new Error("service.heartbeat goes on the health stream: use publishHealth()");
    const parsed = EventPayloads[type].parse(data);
    let id: string | null;
    try {
      id = await this.pub.xadd(
        STREAM, "MAXLEN", "~", MAXLEN, "*",
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

  /** Publish a heartbeat to `cohost:health` (validated; never touches `cohost:events`). */
  // @spec BUS-HEALTH-001, BUS-HEALTH-002, BUS-STREAM-007
  async publishHealth(data: EventInput<"service.heartbeat">): Promise<string> {
    const parsed = EventPayloads["service.heartbeat"].parse(data);
    try {
      return (await this.pub.xadd(
        HEALTH_STREAM, "MAXLEN", "~", HEALTH_MAXLEN, "*",
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

  /** Non-group live tail of the health stream. Does not ack. */
  // @spec BUS-HEALTH-003, BUS-TAIL-003, BUS-TAIL-004
  async tailHealth(handler: (hb: HeartbeatEvent) => void, fromId = "$"): Promise<void> {
    const conn = this.connect(this.url, { maxRetriesPerRequest: null });
    this.subs.push(conn);
    let last = fromId;
    let failures = 0;
    while (!this.stopped) {
      let res: [string, [string, string[]][]][] | null;
      try {
        res = (await conn.xread("COUNT", 100, "BLOCK", 5000, "STREAMS", HEALTH_STREAM, last)) as typeof res;
      } catch (err) {
        if (this.stopped) break;
        await this.backoff(err, ++failures, "tailHealth read failed");
        continue;
      }
      failures = 0;
      if (!res) continue;
      for (const [id, fields] of res[0]?.[1] ?? []) {
        last = id;
        const ev = decode(id, fields);
        if (ev?.type === "service.heartbeat") this.guard(() => handler(ev as HeartbeatEvent), ev.type, id);
      }
    }
    conn.disconnect();
  }

  /** Newest N heartbeats, oldest first. */
  // @spec BUS-HEALTH-004
  async recentHealth(count = 100): Promise<HeartbeatEvent[]> {
    const rows = (await this.pub.xrevrange(HEALTH_STREAM, "+", "-", "COUNT", count)) as [string, string[]][];
    return rows
      .map(([id, f]) => decode(id, f))
      .filter((e): e is HeartbeatEvent => e?.type === "service.heartbeat")
      .reverse();
  }

  /**
   * Point a consumer group at the stream's newest entry (`XGROUP SETID <group> $`), creating the
   * group (and stream) at `$` if it does not exist. Used for "fresh" service starts.
   */
  // @spec BUS-GROUP-001
  async resetGroup(group: string): Promise<void> {
    try {
      await this.pub.xgroup("SETID", STREAM, group, "$");
    } catch (e) {
      if (!String(e).includes("NOGROUP")) throw e;
      try {
        await this.pub.xgroup("CREATE", STREAM, group, "$", "MKSTREAM");
      } catch (e2) {
        if (!String(e2).includes("BUSYGROUP")) throw e2;
      }
    }
  }

  /** Consumer-group subscription. Resolves when stop() is called. */
  // @spec BUS-SUB-001, BUS-SUB-002, BUS-SUB-003, BUS-SUB-004, BUS-SUB-005, BUS-SUB-006, BUS-SUB-009, BUS-SUB-010
  async subscribe<T extends EventType>(opts: SubscribeOptions<T>, handler: Handler<T>): Promise<void> {
    const conn = this.connect(this.url, { maxRetriesPerRequest: null });
    this.subs.push(conn);
    const mode: SubscribeStart = opts.start ?? "latest";
    try {
      await conn.xgroup("CREATE", STREAM, opts.group, "$", "MKSTREAM");
    } catch (e) {
      if (!String(e).includes("BUSYGROUP")) throw e;
      if (mode === "latest") await conn.xgroup("SETID", STREAM, opts.group, "$");
    }
    const wanted = opts.types ? new Set<string>(opts.types) : undefined;
    const block = opts.blockMs ?? 5000;

    // First drain one batch of this consumer's own pending entries, then read new ones. A restarted
    // process has a new consumer name, so entries its predecessor left pending are not redelivered.
    let cursor: string = "0";
    let failures = 0;
    while (!this.stopped) {
      let res: [string, [string, string[]][]][] | null;
      try {
        res = (await conn.xreadgroup(
          "GROUP", opts.group, this.consumer, "COUNT", 50, "BLOCK", block, "STREAMS", STREAM, cursor,
        )) as typeof res;
      } catch (err) {
        if (this.stopped) break; // stop() closed the connection under a blocking read
        await this.backoff(err, ++failures, "subscribe read failed");
        continue;
      }
      failures = 0;
      if (!res) { cursor = ">"; continue; }
      const entries = res[0]?.[1] ?? [];
      if (cursor === "0" && entries.length === 0) { cursor = ">"; continue; }
      for (const [id, fields] of entries) {
        const ev = decode(id, fields);
        if (ev && (!wanted || wanted.has(ev.type))) {
          try {
            await handler(ev as BusEvent<T>);
          } catch (err) {
            this.log?.error({ err, type: ev.type, id }, "handler failed");
          }
        }
        try {
          await conn.xack(STREAM, opts.group, id);
        } catch (err) {
          this.log?.warn({ err, id }, "ack failed"); // at-most-once: the handled entry is not redelivered
        }
      }
      if (cursor === "0") cursor = ">";
    }
    conn.disconnect();
  }

  /** Non-group live tail (dashboard). Does not ack, does not replay. */
  // @spec BUS-TAIL-001, BUS-TAIL-003, BUS-TAIL-004
  async tail(handler: (ev: BusEvent) => void, fromId = "$"): Promise<void> {
    const conn = this.connect(this.url, { maxRetriesPerRequest: null });
    this.subs.push(conn);
    let last = fromId;
    let failures = 0;
    while (!this.stopped) {
      let res: [string, [string, string[]][]][] | null;
      try {
        res = (await conn.xread("COUNT", 100, "BLOCK", 5000, "STREAMS", STREAM, last)) as typeof res;
      } catch (err) {
        if (this.stopped) break;
        await this.backoff(err, ++failures, "tail read failed");
        continue;
      }
      failures = 0;
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
    const rows = (await this.pub.xrevrange(STREAM, "+", "-", "COUNT", count)) as [string, string[]][];
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

const shutdownHooks: (() => void | Promise<void>)[] = [];
/** Max time pre-shutdown hooks (e.g. the `stopping` heartbeat) may delay exit. */
const HOOK_TIMEOUT_MS = 2000;

/** Register work that must finish before the service's own onShutdown callback runs. */
export function beforeShutdown(fn: () => void | Promise<void>): void {
  shutdownHooks.push(fn);
}

type ShutdownLog = Pick<Logger, "error">;
const shutdownCallbacks: { fn: () => void | Promise<void>; log?: ShutdownLog }[] = [];
let shutdownInstalled = false;
let shutdownStarted = false;

/** The process-wide shutdown sequence: hooks (<= 2 s), then every callback in order, then exit(0) once. */
async function runShutdown(): Promise<void> {
  if (shutdownStarted) return;
  shutdownStarted = true;
  try {
    await Promise.race([
      // `async` turns a synchronous throw from a hook into a rejection, which allSettled absorbs.
      Promise.allSettled(shutdownHooks.map(async (h) => h())),
      new Promise((r) => setTimeout(r, HOOK_TIMEOUT_MS).unref()),
    ]);
    for (const { fn, log } of shutdownCallbacks) {
      try {
        await fn();
      } catch (err) {
        if (log) log.error({ err }, "shutdown callback failed");
        else console.error("shutdown callback failed", err);
      }
    }
  } finally { process.exit(0); }
}

/**
 * Shared graceful-shutdown helper for services. Every registration joins one per-process sequence
 * (the signal handlers are installed once); `log` is optional and falls back to `console.error`.
 */
// @spec BUS-STOP-002, BUS-STOP-003, BUS-STOP-004, BUS-STOP-005, BUS-STOP-006
export function onShutdown(fn: () => void | Promise<void>, log?: ShutdownLog): void {
  shutdownCallbacks.push({ fn, log });
  if (shutdownInstalled) return;
  shutdownInstalled = true;
  process.on("SIGINT", () => { void runShutdown(); });
  process.on("SIGTERM", () => { void runShutdown(); });
}

export * from "./heartbeat.js";
