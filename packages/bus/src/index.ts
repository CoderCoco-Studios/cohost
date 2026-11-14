import { randomUUID } from "node:crypto";
import { urls, type Logger } from "@cohost/config";
import type { BusReader, RawEntry, BusTransport, TransportFactory } from "./transport.js";
import { EventPayloads, type BusEvent, type EventInput, type EventType } from "./events.js";
import { HEALTH_MAXLEN, audioStream, connectorKey, createNativeTransport } from "./native.js";

import {
  LEASE_INTERVALS, parseRegistration,
  type AudioDirection, type DecodedFrame, type Frame, type Registration,
} from "./connector.js";

export * from "./events.js";
export * from "./connector.js";
export * from "./registrar.js";
export * from "./transport.js";

export const STREAM = "cohost:events";
/** Heartbeats live on their own capped stream so they never evict domain events. */
export const HEALTH_STREAM = "cohost:health";
/** The heartbeat stream's cap; the native crate defines it (BUS-NAT-RS-004). */
export { HEALTH_MAXLEN };

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

/** Optional construction hooks, additive to `(source, log?, url?)`. Production defaults need none of them. */
export interface BusOptions {
  /** Builds the `BusTransport` the instance runs on (default: the native transport). Tests pass a fake (BUS-NAT-API-004). */
  transport?: TransportFactory;
  /** First retry delay after a failed read, ms (default 250; doubles per consecutive failure). */
  retryBaseMs?: number;
  /** Cap on the retry delay, ms (default 30000). */
  retryMaxMs?: number;
  /** Stream key prefix: the instance uses `<prefix>:events` and `<prefix>:health` (default `cohost`). Tests use their own. */
  streamPrefix?: string;
  /** Do not reconnect: an unreachable Redis rejects the first command with `BUS_CONNECTION` and prints nothing (BUS-STREAM-009). For short-lived CLIs. */
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
 * Typed facade over the bus's Redis Streams. The transport (native by default) executes every Redis command; this class
 * owns validation, envelopes, every read loop, backoff and the start modes (event-bus design, "Native transport").
 * Publish is fire-and-forget; subscribe runs a consumer-group loop until stop().
 */
// @spec BUS-STREAM-005, BUS-NAT-API-001, BUS-NAT-API-004
export class Bus {
  private readonly transport: BusTransport;
  private stopped = false;
  private closing?: Promise<void>;
  readonly consumer = `${process.env.HOSTNAME ?? "local"}-${randomUUID().slice(0, 8)}`;

  private retryBaseMs: number;
  private retryMaxMs: number;
  private wake = new Set<() => void>();
  /** Stream key prefix of this instance (BUS-STREAM-008). */
  private readonly prefix: string;

  constructor(private source: string, private log?: Logger, url = urls.redis(), options: BusOptions = {}) {
    this.retryBaseMs = options.retryBaseMs ?? RETRY_BASE_MS;
    this.retryMaxMs = options.retryMaxMs ?? RETRY_MAX_MS;
    this.prefix = options.streamPrefix ?? DEFAULT_PREFIX;
    // @spec BUS-STREAM-009
    this.transport = (options.transport ?? createNativeTransport)(url, { prefix: this.prefix, failFast: options.failFast ?? false });
  }

  // @spec BUS-STREAM-001, BUS-STREAM-002, BUS-STREAM-003, BUS-STREAM-004, BUS-STREAM-007, BUS-NAT-API-005, BUS-NAT-ERR-005
  async publish<T extends EventType>(type: T, data: EventInput<T>): Promise<string> {
    if (type === "service.heartbeat") throw new Error("service.heartbeat goes on the health stream: use publishHealth()");
    const parsed = EventPayloads[type].parse(data);
    let id: string;
    try {
      id = await this.transport.append("events", { type, ts: String(Date.now()), source: this.source, data: JSON.stringify(parsed) });
    } catch (err) {
      this.log?.warn({ err, type }, "publish failed");
      throw err;
    }
    this.log?.debug({ type, id }, "published");
    return id;
  }

  /** Store an injected test upload under `<prefix>:upload:<id>`, expiring after `ttlMs`. Not a stream entry. */
  // @spec BUS-UPL-001, BUS-UPL-003
  putUpload(id: string, bytes: Buffer, ttlMs: number): Promise<void> {
    return this.transport.putUpload(id, bytes, ttlMs);
  }

  /** Read and delete an upload in one step; `null` when it does not exist or has expired. */
  // @spec BUS-UPL-002
  takeUpload(id: string): Promise<Buffer | null> {
    return this.transport.takeUpload(id);
  }

  /** The key of a connector's registration, `<prefix>:connector:<id>` (BUS-AUD-002, BUS-NAT-RS-006). */
  connectorKey(id: string): string { return connectorKey(this.prefix, id); }

  /** The stream of a source (`in`) or sink (`out`), `<prefix>:audio.<dir>.<tag>` (BUS-AUD-001, BUS-NAT-RS-006). */
  audioStream(dir: AudioDirection, tag: string): string { return audioStream(this.prefix, dir, tag); }

  /** Write a registration under its key with a lease of three intervals; not a stream entry. */
  // @spec CONN-REG-001, CONN-REG-002, BUS-AUD-002
  writeRegistration(reg: Registration): Promise<void> {
    return this.transport.writeRegistration(reg.id, JSON.stringify(reg), reg.intervalMs * LEASE_INTERVALS);
  }

  /** The live registration of `id`, or `undefined`. */
  async readRegistration(id: string): Promise<Registration | undefined> {
    return parseRegistration(await this.transport.readRegistration(id));
  }

  /** Delete the registration of `id` (orderly shutdown). */
  // @spec CONN-REG-003
  deleteRegistration(id: string): Promise<void> {
    return this.transport.deleteRegistration(id);
  }

  /** Every live registration (one scan, one read). Invalid values are skipped. */
  // @spec CONN-REG-006, BUS-AUD-002
  async listConnectors(): Promise<Registration[]> {
    return (await this.transport.listRegistrations()).flatMap((v) => { const r = parseRegistration(v); return r ? [r] : []; });
  }

  /**
   * Append one audio frame to `audio.<dir>.<tag>` (capped, 60 s expiry, one pipeline in the transport). Rejects
   * `BUS_INVALID` and writes nothing for an oversized or odd-length `pcm`. Never waits for a consumer (CONN-BP-001);
   * `publish` neither writes nor trims these streams (BUS-AUD-001).
   */
  // @spec CONN-AUD-001, CONN-BP-001, BUS-AUD-001, BUS-NAT-FRM-001, BUS-NAT-FRM-002
  publishFrame(dir: AudioDirection, tag: string, frame: Frame): Promise<string> {
    return this.transport.appendFrame(dir, tag, frame);
  }

  /**
   * Live read of `audio.<dir>.<tag>`: plain blocking `XREAD` from the end (`$`), no group, no acknowledgement, no replay
   * (CONN-BP-002). Resolves when `stop()` is called. A handler throw is logged and the loop continues.
   */
  // @spec CONN-BP-002, BUS-AUD-001, BUS-NAT-CONN-002
  async tailAudio(dir: AudioDirection, tag: string, handler: (decoded: DecodedFrame, id: string) => void, onRead?: ReadOutcome): Promise<void> {
    const reader = this.openReader();
    if (!reader) return;
    let last = "$";
    let failures = 0;
    try {
      while (!this.stopped) {
        let rows;
        try {
          rows = await reader.readFrames(dir, tag, last, 100, 5000);
        } catch (err) {
          if (this.stopped) break;
          report(onRead, err ?? new Error("read failed"));
          await this.backoff(err, ++failures, "tailAudio read failed");
          continue;
        }
        failures = 0;
        report(onRead);
        if (!rows) continue;
        for (const row of rows) {
          last = row.id;
          this.guard(() => handler(row.decoded, row.id), `audio.${dir}.${tag}`, row.id);
        }
      }
    } finally { closeQuietly(reader); }
  }

  /** Publish a heartbeat to `cohost:health` (validated; never touches `cohost:events`). */
  // @spec BUS-HEALTH-001, BUS-HEALTH-002, BUS-STREAM-007, BUS-NAT-API-005
  async publishHealth(data: EventInput<"service.heartbeat">): Promise<string> {
    const parsed = EventPayloads["service.heartbeat"].parse(data);
    try {
      return await this.transport.append("health", { type: "service.heartbeat", ts: String(Date.now()), source: this.source, data: JSON.stringify(parsed) });
    } catch (err) {
      this.log?.warn({ err, type: "service.heartbeat" }, "publish failed");
      throw err;
    }
  }

  /** Non-group live tail of the health stream. Does not ack. `onRead` hears each read's outcome (BUS-TAIL-005). */
  // @spec BUS-HEALTH-003, BUS-TAIL-003, BUS-TAIL-004, BUS-TAIL-005
  tailHealth(handler: (hb: HeartbeatEvent) => void, fromId = "$", onRead?: ReadOutcome): Promise<void> {
    return this.tailStream("health", fromId, onRead, "tailHealth read failed", (ev) => {
      if (ev.type === "service.heartbeat") this.guard(() => handler(ev as HeartbeatEvent), ev.type, ev.id);
    });
  }

  /** The Redis server's clock in ms (`TIME`): one reference for every observer, whatever its own clock says. */
  // @spec CTRL-CHECK-004, BUS-NAT-API-009
  serverTime(): Promise<number> {
    return this.transport.serverTime();
  }

  /** Newest N heartbeats, oldest first. */
  // @spec BUS-HEALTH-004
  async recentHealth(count = 100): Promise<HeartbeatEvent[]> {
    return (await this.transport.recent("health", count))
      .map(decode)
      .filter((e): e is HeartbeatEvent => e?.type === "service.heartbeat");
  }

  /**
   * Point a consumer group at the stream's newest entry, creating the group (and stream) at `$` if it does not exist.
   * Used for "fresh" service starts: `createGroup` first, `moveGroupToLatest` only when the group already existed.
   */
  // @spec BUS-GROUP-001, BUS-NAT-API-008
  async resetGroup(group: string): Promise<void> {
    if (!(await this.transport.createGroup(group))) await this.transport.moveGroupToLatest(group);
  }

  /** Consumer-group subscription. Resolves when stop() is called. */
  // @spec BUS-SUB-001, BUS-SUB-002, BUS-SUB-003, BUS-SUB-004, BUS-SUB-005, BUS-SUB-006, BUS-SUB-008, BUS-SUB-009, BUS-SUB-010, BUS-SUB-011, BUS-SUB-012, BUS-SUB-013
  // @spec BUS-NAT-API-007, BUS-NAT-ACK-001, BUS-NAT-ACK-002, BUS-NAT-ACK-003, BUS-NAT-ACK-008, BUS-NAT-CONN-002, BUS-NAT-CONN-003, BUS-NAT-ERR-003, BUS-NAT-ERR-004, BUS-NAT-TRN-007
  async subscribe<T extends EventType>(opts: SubscribeOptions<T>, handler: Handler<T>): Promise<void> {
    const mode = opts.start as unknown;
    if (mode !== "latest" && mode !== "resume") {
      throw new Error(`Bus.subscribe: start must be "latest" or "resume", got ${JSON.stringify(mode)}`);
    }
    const group = opts.group;
    let reader: BusReader | undefined;
    try {
      if (!(await this.transport.createGroup(group)) && mode === "latest") await this.transport.moveGroupToLatest(group);
      reader = this.transport.openReader();
    } catch (err) {
      if (this.stopped) return; // stop() closed the transport under the group creation
      throw err;
    }
    try {
      opts.onReady?.();
      const wanted = opts.types ? new Set<string>(opts.types) : undefined;
      const block = opts.blockMs ?? 5000;
      /** Ids whose ack Redis refused once (redelivered once) and twice (dropped for good). */
      const refused = new Set<string>();
      const dropped = new Set<string>();

      // First drain this consumer's own pending entries, a batch at a time from the last id seen (so an entry that
      // stays pending, for instance after a refused XACK, cannot hold the drain), then read new ones. A restarted
      // process has a new consumer name, so entries its predecessor left pending are not redelivered. After a failed
      // read the loop drains again from cursor 0.
      let cursor = "0";
      let failures = 0;
      while (!this.stopped) {
        let res;
        try {
          res = await reader.readGroup(group, this.consumer, cursor, 50, block);
        } catch (err) {
          if (this.stopped) break; // stop() closed the reader under a blocking read
          await this.backoff(err, ++failures, "subscribe read failed");
          cursor = "0";
          continue;
        }
        failures = 0;
        for (const { ids, err } of res.ackErrors) {
          const again = ids.filter((id) => refused.has(id));
          const first = ids.filter((id) => !refused.has(id));
          if (first.length) { this.log?.warn({ err, ids: first }, "ack failed"); for (const id of first) refused.add(id); }
          if (again.length) { this.log?.warn({ err, ids: again }, "ack failed, entry dropped"); for (const id of again) dropped.add(id); }
        }
        const entries = res.entries;
        if (!entries || (cursor !== ">" && entries.length === 0)) { cursor = ">"; continue; }
        for (const raw of entries) {
          if (this.stopped) break; // stop() landed during the previous handler: nothing further is handled or acked
          const id = raw.id;
          if (dropped.has(id)) { if (cursor !== ">") cursor = id; continue; }
          const ev = decode(raw);
          if (ev && (!wanted || wanted.has(ev.type))) {
            try {
              await handler(ev as BusEvent<T>);
            } catch (err) {
              this.log?.error({ err, type: ev.type, id }, "handler failed");
            }
          }
          if (this.stopped) break; // the transport is closing: no ack after stop
          try { reader.ack(group, id); } catch { /* the reader closed under us: at-most-once */ }
          if (cursor !== ">") cursor = id;
        }
      }
    } finally { closeQuietly(reader); }
  }

  /** Non-group live tail (dashboard). Does not ack, does not replay. `onRead` hears each read's outcome (BUS-TAIL-005). */
  // @spec BUS-TAIL-001, BUS-TAIL-003, BUS-TAIL-004, BUS-TAIL-005
  tail(handler: (ev: BusEvent) => void, fromId = "$", onRead?: ReadOutcome): Promise<void> {
    return this.tailStream("events", fromId, onRead, "tail read failed", (ev) => this.guard(() => handler(ev), ev.type, ev.id));
  }

  /** Most recent N events (dashboard backfill). */
  // @spec BUS-TAIL-002
  async recent(count = 100): Promise<BusEvent[]> {
    return (await this.transport.recent("events", count)).map(decode).filter((e): e is BusEvent => !!e);
  }

  /** The loop of `tail` and `tailHealth`: `XREAD` batches from the last id delivered, until stop(). */
  private async tailStream(stream: "events" | "health", fromId: string, onRead: ReadOutcome | undefined, msg: string, deliver: (ev: BusEvent) => void): Promise<void> {
    const reader = this.openReader();
    if (!reader) return;
    let last = fromId;
    let failures = 0;
    try {
      while (!this.stopped) {
        let rows: RawEntry[] | null;
        try {
          rows = await reader.read(stream, last, 100, 5000);
        } catch (err) {
          if (this.stopped) break;
          report(onRead, err ?? new Error("read failed"));
          await this.backoff(err, ++failures, msg);
          continue;
        }
        failures = 0;
        report(onRead);
        if (!rows) continue;
        for (const raw of rows) {
          last = raw.id;
          const ev = decode(raw);
          if (ev) deliver(ev);
        }
      }
    } finally { closeQuietly(reader); }
  }

  /** A reader for one loop; `undefined` when `stop()` closed the transport first, anything else is rethrown. */
  private openReader(): BusReader | undefined {
    try { return this.transport.openReader(); } catch (err) {
      if (this.stopped) return undefined;
      throw err;
    }
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

  /**
   * Mark the instance stopped, wake every backoff sleep and close the transport, which sends the queued acks (at most
   * 2 s) and ends every blocked read. Resolves once the transport has closed; repeated calls share that close.
   */
  // @spec BUS-STOP-001, BUS-NAT-ACK-005, BUS-NAT-ACK-006, BUS-NAT-ACK-007, BUS-NAT-ERR-008
  stop(): Promise<void> {
    this.stopped = true;
    for (const w of [...this.wake]) w();
    if (!this.closing) {
      try { this.closing = this.transport.close().catch(() => {}); } catch { this.closing = Promise.resolve(); }
    }
    return this.closing;
  }
}

function closeQuietly(reader: BusReader): void {
  try { reader.close(); } catch { /* already closed */ }
}

/** Rebuild a `BusEvent` from a transport entry; `undefined` for an unknown type, non-JSON `data`, a schema failure or an entry with no fields. */
// @spec BUS-STREAM-006, BUS-SUB-007, BUS-NAT-API-006, BUS-NAT-ERR-007
function decode(raw: RawEntry): BusEvent | undefined {
  const type = raw.type as EventType | undefined;
  if (!type || !Object.hasOwn(EventPayloads, type)) return undefined;
  try {
    return {
      id: raw.id,
      type,
      ts: Number(raw.ts ?? 0),
      source: raw.source ?? "?",
      data: EventPayloads[type].parse(JSON.parse(raw.data ?? "{}")) as never,
    };
  } catch {
    return undefined;
  }
}
