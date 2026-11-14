/**
 * The seam between the `Bus` facade and the native Redis transport (event-bus design, "The BusTransport interface").
 * Types only. Specs: BUS-NAT-TRN-*, BUS-NAT-ACK-*, BUS-NAT-ERR-*.
 */
import type { AudioDirection, DecodedFrame, Frame } from "./connector.js";

export type EventStream = "events" | "health";

/** The `code` of every error the transport rejects with (BUS-NAT-ERR-001). */
export type BusErrorCode = "BUS_CONNECTION" | "BUS_REDIS" | "BUS_CLOSED" | "BUS_INVALID" | "BUS_INTERNAL";

/** The four envelope fields as stored (BUS-STREAM-001). */
export interface EntryFields { type: string; ts: string; source: string; data: string }

/**
 * One entry as read. Only the four envelope fields are returned; a missing field is undefined. A pending entry whose
 * stream entry was trimmed, and an entry with an envelope field that is not valid UTF-8, come back with no fields.
 */
export interface RawEntry { id: string; type?: string; ts?: string; source?: string; data?: string }

export interface AckError { ids: string[]; err: Error }

/** `entries` is null when the block timed out with nothing to read. */
export interface GroupRead { entries: RawEntry[] | null; ackErrors: AckError[] }

export interface FrameEntry { id: string; decoded: DecodedFrame }

export interface BusTransport {
  /** XADD <prefix>:<stream> MAXLEN ~ 20000 (events) | 1000 (health) * type ts source data. Resolves to the id. */
  append(stream: EventStream, fields: EntryFields): Promise<string>;
  /** XREVRANGE <prefix>:<stream> + - COUNT n, returned oldest first. */
  recent(stream: EventStream, count: number): Promise<RawEntry[]>;
  /** XGROUP CREATE <prefix>:events <group> $ MKSTREAM. true: created; false: BUSYGROUP; any other error rejects. */
  createGroup(group: string): Promise<boolean>;
  /** XGROUP SETID <prefix>:events <group> $. */
  moveGroupToLatest(group: string): Promise<void>;
  /** SET <prefix>:upload:<id> <bytes> PX ttlMs (BUS-UPL-001). */
  putUpload(id: string, bytes: Buffer, ttlMs: number): Promise<void>;
  /** GETDEL <prefix>:upload:<id> (BUS-UPL-002). */
  takeUpload(id: string): Promise<Buffer | null>;
  /** SET <prefix>:connector:<id> <json> PX leaseMs (CONN-REG-001). */
  writeRegistration(id: string, json: string, leaseMs: number): Promise<void>;
  /** GET <prefix>:connector:<id>. */
  readRegistration(id: string): Promise<string | null>;
  /** DEL <prefix>:connector:<id> (CONN-REG-003). */
  deleteRegistration(id: string): Promise<void>;
  /** SCAN MATCH <prefix>:connector:* COUNT 100 to cursor 0, de-duplicated, then one MGET; values that exist (CONN-REG-006). */
  listRegistrations(): Promise<string[]>;
  /**
   * Encode, then XADD <prefix>:audio.<dir>.<tag> MAXLEN ~ cap(dir) * ... and PEXPIRE 60000 in one pipeline (CONN-AUD-001).
   * Rejects BUS_INVALID, writing nothing, when pcm exceeds MAX_FRAME_BYTES or has an odd byte count.
   */
  appendFrame(dir: AudioDirection, tag: string, frame: Frame): Promise<string>;
  /** TIME, as epoch ms (CTRL-CHECK-004). */
  serverTime(): Promise<number>;
  /** A reader with its own connection, for one blocking loop. */
  openReader(): BusReader;
  /**
   * Send every reader's queued acks on the shared connection in one pipeline (nothing when none are queued), then close
   * the shared connection and every reader; blocked reads reject with BUS_CLOSED. The flush is abandoned after 2000 ms.
   * Never rejects: a failed or abandoned flush is not retried. A second close() resolves when the first has. Every other
   * method called afterwards rejects with BUS_CLOSED.
   */
  close(): Promise<void>;
}

export interface BusReader {
  /**
   * Sends the queued acks of this reader, then XREADGROUP GROUP <group> <consumer> COUNT n BLOCK ms STREAMS <prefix>:events
   * <cursor>, in one pipeline. `ackErrors` reports queued acks that Redis refused.
   */
  readGroup(group: string, consumer: string, cursor: string, count: number, blockMs: number): Promise<GroupRead>;
  /** Queue XACK <prefix>:events <group> <id>; synchronous, sent with the next readGroup or by the transport's close(). */
  ack(group: string, id: string): void;
  /** XREAD COUNT n BLOCK ms STREAMS <prefix>:<stream> <fromId>. null on timeout. */
  read(stream: EventStream, fromId: string, count: number, blockMs: number): Promise<RawEntry[] | null>;
  /** XREAD on <prefix>:audio.<dir>.<tag>, each entry decoded by the frame codec (never throws, CONN-BP-006). null on timeout. */
  readFrames(dir: AudioDirection, tag: string, fromId: string, count: number, blockMs: number): Promise<FrameEntry[] | null>;
  /** Close this reader's connection, dropping its queued acks; a blocked read rejects with BUS_CLOSED. */
  close(): void;
}

export type TransportFactory = (url: string, opts: { prefix: string; failFast: boolean }) => BusTransport;
