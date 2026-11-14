/**
 * A scripted `BusTransport` for facade tests: the Bus runs its loops, validation and backoff against it with no Redis
 * server and no native addon (BUS-NAT-API-011). `FakeFrameTransport` below does the same for the frames path. It models the transport rules a facade test depends on: acks queue on
 * the reader and travel with the next `readGroup`, a failed pipeline keeps them queued, `close()` flushes them, and a
 * call after `close()` rejects `BUS_CLOSED`.
 */
import type {
  AckError, AudioDirection, BusErrorCode, BusReader, BusTransport, EntryFields, EventStream, Frame, FrameEntry, FrameReader,
  FrameTransport, FrameTransportFactory, GroupRead, RawEntry, TransportFactory,
} from "@cohost/bus";

/** An `Error` with the `code` the binding gives its rejections (BUS-NAT-ERR-001). */
export function busError(code: BusErrorCode, message: string = code): Error & { code: BusErrorCode } {
  return Object.assign(new Error(message), { code });
}

type Fn = (...args: any[]) => unknown;
export type TransportMethod =
  | "append" | "recent" | "createGroup" | "moveGroupToLatest" | "putUpload" | "takeUpload" | "writeRegistration"
  | "readRegistration" | "deleteRegistration" | "listRegistrations" | "serverTime" | "openReader" | "close"
  | "readGroup" | "ack" | "read" | "readerClose";

/** One recorded call. `reader` is the 1-based number of the reader it was made on, for reader methods. */
export interface Call { method: TransportMethod; args: unknown[]; reader?: number; at: number; /** `readGroup` only: the acks queued on the reader when the call was made, which travel with it. */ acks?: string[] }

/** An entry of the wire form `readGroup` / `read` return, with the envelope fields filled in. */
export function rawEntry(id: string, type = "control", data: object | string = { cmd: "mute" }, over: Partial<RawEntry> = {}): RawEntry {
  return { id, type, ts: "1", source: "t", data: typeof data === "string" ? data : JSON.stringify(data), ...over };
}
export const groupRead = (entries: RawEntry[] | null, ackErrors: AckError[] = []): GroupRead => ({ entries, ackErrors });

let idSeq = 0;
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

export class FakeTransport implements BusTransport {
  /** Every call, in order, on the transport and on its readers. */
  calls: Call[] = [];
  /** What the facade passed to the factory, one entry per call. */
  factoryCalls: { url: string; opts: { prefix: string; failFast: boolean } }[] = [];
  /**
   * Scripted results, consumed one per call in order: a function receives the call's arguments and returns the result
   * (a Promise to delay it, a thrown or rejected error to fail it). With the queue empty a method uses its default.
   * Unscripted blocking reads wait until `close()` and then reject `BUS_CLOSED`, like an idle Redis.
   */
  script: Partial<Record<TransportMethod, Fn[]>> = {};
  /** Ids Redis refuses to ack: a reader that sends one reports it in `ackErrors`. */
  refusedAcks = new Set<string>();
  /** The ids acked, flushed by a `close()`. */
  flushedAtClose: { group: string; id: string }[] = [];
  /** Make the `close()` flush fail (BUS-NAT-ACK-006): the acks are not recorded in `flushedAtClose`. */
  flushFails = false;
  /** How long `close()` takes to resolve, ms. */
  closeDelayMs = 0;
  closed = false;
  readers: FakeReader[] = [];
  private closing?: Promise<void>;
  private waiters = new Set<(e: Error) => void>();
  /** `serverTime()` default result. */
  serverNow = 1_700_000_000_000;

  /** A factory the `Bus` can take as `BusOptions.transport`; it records its arguments and returns this transport. */
  readonly factory: TransportFactory = (url, opts) => { this.factoryCalls.push({ url, opts }); return this; };

  /** Queue scripted results for a method. */
  on(method: TransportMethod, ...fns: Fn[]): this { (this.script[method] ??= []).push(...fns); return this; }
  /** Queue a plain value (not a function) for a method. */
  resolveOnce(method: TransportMethod, value: unknown): this { return this.on(method, () => value); }
  /** Queue a rejection with a coded error. */
  failOnce(method: TransportMethod, code: BusErrorCode = "BUS_CONNECTION", message?: string): this {
    return this.on(method, () => { throw busError(code, message); });
  }
  of(method: TransportMethod): Call[] { return this.calls.filter((c) => c.method === method); }
  /** The method names in call order, to assert an ordering. */
  names(): TransportMethod[] { return this.calls.map((c) => c.method); }

  /** @internal */
  record(method: TransportMethod, args: unknown[], reader?: number): void { this.calls.push({ method, args, reader, at: performance.now() }); }

  /** @internal Run the scripted result, or `dflt`, for a call. Rejects `BUS_CLOSED` once closed. */
  async run<T>(method: TransportMethod, args: unknown[], dflt: () => T | Promise<T>, reader?: number): Promise<T> {
    this.record(method, args, reader);
    if (this.closed) throw busError("BUS_CLOSED", "transport closed");
    const fn = this.script[method]?.shift();
    return (fn ? await fn(...args) : await dflt()) as T;
  }

  /** @internal A read that returns only when closed (rejecting `BUS_CLOSED`). */
  idle<T>(): Promise<T> {
    return new Promise<T>((_, reject) => { this.waiters.add(reject); });
  }

  append(stream: EventStream, fields: EntryFields) { return this.run("append", [stream, fields], () => `${Date.now()}-${idSeq++}`); }
  recent(stream: EventStream, count: number) { return this.run("recent", [stream, count], (): RawEntry[] => []); }
  createGroup(group: string) { return this.run("createGroup", [group], () => true); }
  moveGroupToLatest(group: string) { return this.run("moveGroupToLatest", [group], () => undefined); }
  putUpload(id: string, bytes: Buffer, ttlMs: number) { return this.run("putUpload", [id, bytes, ttlMs], () => undefined); }
  takeUpload(id: string) { return this.run("takeUpload", [id], (): Buffer | null => null); }
  writeRegistration(id: string, json: string, leaseMs: number) { return this.run("writeRegistration", [id, json, leaseMs], () => undefined); }
  readRegistration(id: string) { return this.run("readRegistration", [id], (): string | null => null); }
  deleteRegistration(id: string) { return this.run("deleteRegistration", [id], () => undefined); }
  listRegistrations() { return this.run("listRegistrations", [], (): string[] => []); }
  serverTime() { return this.run("serverTime", [], () => this.serverNow); }

  openReader(): BusReader {
    this.record("openReader", []);
    if (this.closed) throw busError("BUS_CLOSED", "transport closed");
    const r = new FakeReader(this, this.readers.length + 1);
    this.readers.push(r);
    return r;
  }

  /** @internal Acks queued on every reader and not yet sent. */
  queuedAcks(): { group: string; id: string }[] { return this.readers.flatMap((r) => r.queued); }

  close(): Promise<void> {
    this.record("close", []);
    if (this.closing) return this.closing;
    this.closing = (async () => {
      if (!this.flushFails) this.flushedAtClose.push(...this.queuedAcks());
      this.closed = true;
      for (const r of this.readers) r.queued = [];
      for (const w of [...this.waiters]) w(busError("BUS_CLOSED", "transport closed"));
      this.waiters.clear();
      if (this.closeDelayMs) await new Promise((r) => setTimeout(r, this.closeDelayMs)); else await tick();
    })();
    return this.closing;
  }
}

export class FakeReader implements BusReader {
  /** Acks queued with `ack()` and not yet sent. */
  queued: { group: string; id: string }[] = [];
  /** Per `readGroup` call: the acks that travelled in its pipeline, ahead of the XREADGROUP. */
  sentWith: { cursor: string; acks: string[] }[] = [];
  closed = false;
  constructor(private t: FakeTransport, readonly n: number) {}

  async readGroup(group: string, consumer: string, cursor: string, count: number, blockMs: number): Promise<GroupRead> {
    this.t.record("readGroup", [group, consumer, cursor, count, blockMs], this.n);
    this.t.calls[this.t.calls.length - 1]!.acks = this.queued.map((a) => a.id);
    if (this.closed || this.t.closed) throw busError("BUS_CLOSED", "reader closed");
    const sent = this.queued;
    const fn = this.t.script.readGroup?.shift();
    let res: GroupRead;
    try {
      res = fn ? ((await fn(group, consumer, cursor, count, blockMs)) as GroupRead) : await this.t.idle<GroupRead>();
    } catch (err) {
      // a pipeline that fails on the connection keeps its acks queued (BUS-NAT-ACK-004); a closed reader drops them
      if ((err as { code?: string }).code === "BUS_CLOSED") this.queued = [];
      throw err;
    }
    this.queued = this.queued.filter((q) => !sent.includes(q));
    this.sentWith.push({ cursor, acks: sent.map((a) => a.id) });
    const refused = sent.filter((a) => this.t.refusedAcks.has(a.id)).map((a) => a.id);
    return refused.length
      ? { ...res, ackErrors: [...res.ackErrors, ...refused.map((id) => ({ ids: [id], err: busError("BUS_REDIS", "NOGROUP No such consumer group") }))] }
      : res;
  }

  ack(group: string, id: string): void {
    this.t.record("ack", [group, id], this.n);
    if (this.closed || this.t.closed) return;
    this.queued.push({ group, id });
  }

  read(stream: EventStream, fromId: string, count: number, blockMs: number): Promise<RawEntry[] | null> {
    return this.blocking("read", [stream, fromId, count, blockMs]);
  }
  private async blocking<T>(method: "read", args: unknown[]): Promise<T> {
    this.t.record(method, args, this.n);
    if (this.closed || this.t.closed) throw busError("BUS_CLOSED", "reader closed");
    const fn = this.t.script[method]?.shift();
    return (fn ? await fn(...args) : await this.t.idle<T>()) as T;
  }

  close(): void {
    this.t.record("readerClose", [], this.n);
    this.closed = true;
    this.queued = [];
  }
}

export type FrameMethod = "appendFrame" | "openReader" | "close" | "readFrames" | "readerClose";
export interface FrameCall { method: FrameMethod; args: unknown[]; reader?: number; at: number }

/**
 * A scripted `FrameTransport` for the frames path (BUS-NAT-API-011, BUS-NAT-FRM-007): records every call, runs scripted
 * results one per call, and rejects `BUS_CLOSED` once closed. Unscripted `readFrames` wait until `close()`.
 */
export class FakeFrameTransport implements FrameTransport {
  calls: FrameCall[] = [];
  factoryCalls: { url: string; opts: { prefix: string; failFast: boolean } }[] = [];
  script: Partial<Record<FrameMethod, Fn[]>> = {};
  closed = false;
  readers: FakeFrameReader[] = [];
  private waiters = new Set<(e: Error) => void>();

  readonly factory: FrameTransportFactory = (url, opts) => { this.factoryCalls.push({ url, opts }); return this; };

  on(method: FrameMethod, ...fns: Fn[]): this { (this.script[method] ??= []).push(...fns); return this; }
  failOnce(method: FrameMethod, code: BusErrorCode = "BUS_CONNECTION", message?: string): this {
    return this.on(method, () => { throw busError(code, message); });
  }
  of(method: FrameMethod): FrameCall[] { return this.calls.filter((c) => c.method === method); }

  /** @internal */
  record(method: FrameMethod, args: unknown[], reader?: number): void { this.calls.push({ method, args, reader, at: performance.now() }); }
  /** @internal */
  idle<T>(): Promise<T> { return new Promise<T>((_, reject) => { this.waiters.add(reject); }); }

  async appendFrame(dir: AudioDirection, tag: string, frame: Frame): Promise<string> {
    this.record("appendFrame", [dir, tag, frame]);
    if (this.closed) throw busError("BUS_CLOSED", "transport closed");
    const fn = this.script.appendFrame?.shift();
    return (fn ? await fn(dir, tag, frame) : `${Date.now()}-${idSeq++}`) as string;
  }

  openReader(): FrameReader {
    this.record("openReader", []);
    if (this.closed) throw busError("BUS_CLOSED", "transport closed");
    const r = new FakeFrameReader(this, this.readers.length + 1);
    this.readers.push(r);
    return r;
  }

  async close(): Promise<void> {
    this.record("close", []);
    this.closed = true;
    for (const w of [...this.waiters]) w(busError("BUS_CLOSED", "transport closed"));
    this.waiters.clear();
    await tick();
  }
}

export class FakeFrameReader implements FrameReader {
  closed = false;
  constructor(private t: FakeFrameTransport, readonly n: number) {}
  async readFrames(dir: AudioDirection, tag: string, fromId: string, count: number, blockMs: number): Promise<FrameEntry[] | null> {
    this.t.record("readFrames", [dir, tag, fromId, count, blockMs], this.n);
    if (this.closed || this.t.closed) throw busError("BUS_CLOSED", "reader closed");
    const fn = this.t.script.readFrames?.shift();
    return (fn ? await fn(dir, tag, fromId, count, blockMs) : await this.t.idle<FrameEntry[] | null>()) as FrameEntry[] | null;
  }
  close(): void { this.t.record("readerClose", [], this.n); this.closed = true; }
}
