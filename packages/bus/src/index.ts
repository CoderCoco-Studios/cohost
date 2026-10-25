import { Redis } from "ioredis";
import { randomUUID } from "node:crypto";
import { urls, type Logger } from "@cohost/config";
import { EventPayloads, type BusEvent, type EventInput, type EventType } from "./events.js";

export * from "./events.js";

export const STREAM = "cohost:events";
const MAXLEN = 20_000;
/** Heartbeats live on their own capped stream so they never evict domain events. */
export const HEALTH_STREAM = "cohost:health";
export const HEALTH_MAXLEN = 1000;

export type Heartbeat = BusEvent<"service.heartbeat">;

export interface SubscribeOptions<T extends EventType> {
  /** Consumer group — one per service. Restarts resume where they left off. */
  group: string;
  /** Only deliver these types (others are acked and skipped). */
  types?: readonly T[];
  /** Start from the newest message instead of replaying backlog on first group creation. */
  fromNow?: boolean;
  /** Block time per read, ms. */
  blockMs?: number;
}

export type Handler<T extends EventType> = (event: BusEvent<T>) => void | Promise<void>;

/** The publishing half of a Bus: what region logic depends on, so tests can pass a recorder. */
export type Publisher = Pick<Bus, "publish">;

/**
 * Thin typed wrapper over one Redis Stream. Publish is fire-and-forget;
 * subscribe runs a consumer-group loop until stop().
 */
export class Bus {
  private pub: Redis;
  private subs: Redis[] = [];
  private stopped = false;
  readonly consumer = `${process.env.HOSTNAME ?? "local"}-${randomUUID().slice(0, 8)}`;

  constructor(private source: string, private log?: Logger, private url = urls.redis()) {
    this.pub = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 3 });
  }

  async publish<T extends EventType>(type: T, data: EventInput<T>): Promise<string> {
    if (type === "service.heartbeat") throw new Error("service.heartbeat goes on the health stream: use publishHealth()");
    const parsed = EventPayloads[type].parse(data);
    const id = await this.pub.xadd(
      STREAM, "MAXLEN", "~", MAXLEN, "*",
      "type", type,
      "ts", String(Date.now()),
      "source", this.source,
      "data", JSON.stringify(parsed),
    );
    this.log?.debug({ type, id }, "published");
    return id as string;
  }

  /** Publish a heartbeat to `cohost:health` (validated; never touches `cohost:events`). */
  async publishHealth(data: EventInput<"service.heartbeat">): Promise<string> {
    const parsed = EventPayloads["service.heartbeat"].parse(data);
    const id = await this.pub.xadd(
      HEALTH_STREAM, "MAXLEN", "~", HEALTH_MAXLEN, "*",
      "type", "service.heartbeat",
      "ts", String(Date.now()),
      "source", this.source,
      "data", JSON.stringify(parsed),
    );
    return id as string;
  }

  /** Non-group live tail of the health stream. Does not ack. */
  async tailHealth(handler: (hb: Heartbeat) => void, fromId = "$"): Promise<void> {
    const conn = new Redis(this.url, { maxRetriesPerRequest: null });
    this.subs.push(conn);
    let last = fromId;
    while (!this.stopped) {
      let res: [string, [string, string[]][]][] | null;
      try {
        res = (await conn.xread("COUNT", 100, "BLOCK", 5000, "STREAMS", HEALTH_STREAM, last)) as typeof res;
      } catch (err) {
        if (this.stopped) break;
        throw err;
      }
      if (!res) continue;
      for (const [id, fields] of res[0]?.[1] ?? []) {
        last = id;
        const ev = decode(id, fields);
        if (ev?.type === "service.heartbeat") handler(ev as Heartbeat);
      }
    }
    conn.disconnect();
  }

  /** Newest N heartbeats, oldest first. */
  async recentHealth(count = 100): Promise<Heartbeat[]> {
    const rows = (await this.pub.xrevrange(HEALTH_STREAM, "+", "-", "COUNT", count)) as [string, string[]][];
    return rows
      .map(([id, f]) => decode(id, f))
      .filter((e): e is Heartbeat => e?.type === "service.heartbeat")
      .reverse();
  }

  /** Consumer-group subscription. Resolves when stop() is called. */
  async subscribe<T extends EventType>(opts: SubscribeOptions<T>, handler: Handler<T>): Promise<void> {
    const conn = new Redis(this.url, { maxRetriesPerRequest: null });
    this.subs.push(conn);
    const start = opts.fromNow ? "$" : "0";
    try {
      await conn.xgroup("CREATE", STREAM, opts.group, start, "MKSTREAM");
    } catch (e) {
      if (!String(e).includes("BUSYGROUP")) throw e;
    }
    const wanted = opts.types ? new Set<string>(opts.types) : undefined;
    const block = opts.blockMs ?? 5000;

    // First drain anything pending for this consumer (crash recovery), then read new.
    let cursor: string = "0";
    while (!this.stopped) {
      let res: [string, [string, string[]][]][] | null;
      try {
        res = (await conn.xreadgroup(
          "GROUP", opts.group, this.consumer, "COUNT", 50, "BLOCK", block, "STREAMS", STREAM, cursor,
        )) as typeof res;
      } catch (err) {
        if (this.stopped) break; // stop() closed the connection under a blocking read
        throw err;
      }
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
        await conn.xack(STREAM, opts.group, id);
      }
      if (cursor === "0") cursor = ">";
    }
    conn.disconnect();
  }

  /** Non-group live tail (dashboard). Does not ack, does not replay. */
  async tail(handler: (ev: BusEvent) => void, fromId = "$"): Promise<void> {
    const conn = new Redis(this.url, { maxRetriesPerRequest: null });
    this.subs.push(conn);
    let last = fromId;
    while (!this.stopped) {
      let res: [string, [string, string[]][]][] | null;
      try {
        res = (await conn.xread("COUNT", 100, "BLOCK", 5000, "STREAMS", STREAM, last)) as typeof res;
      } catch (err) {
        if (this.stopped) break;
        throw err;
      }
      if (!res) continue;
      for (const [id, fields] of res[0]?.[1] ?? []) {
        last = id;
        const ev = decode(id, fields);
        if (ev) handler(ev);
      }
    }
    conn.disconnect();
  }

  /** Most recent N events (dashboard backfill). */
  async recent(count = 100): Promise<BusEvent[]> {
    const rows = (await this.pub.xrevrange(STREAM, "+", "-", "COUNT", count)) as [string, string[]][];
    return rows.map(([id, f]) => decode(id, f)).filter((e): e is BusEvent => !!e).reverse();
  }

  stop(): void {
    this.stopped = true;
    for (const c of this.subs) c.disconnect();
    this.pub.disconnect();
  }
}

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

/** Shared graceful-shutdown helper for services. */
export function onShutdown(fn: () => void | Promise<void>): void {
  let done = false;
  const run = async () => {
    if (done) return;
    done = true;
    try {
      await Promise.race([
        Promise.allSettled(shutdownHooks.map((h) => h())),
        new Promise((r) => setTimeout(r, HOOK_TIMEOUT_MS).unref()),
      ]);
      await fn();
    } finally { process.exit(0); }
  };
  process.on("SIGINT", run);
  process.on("SIGTERM", run);
}

export * from "./heartbeat.js";
