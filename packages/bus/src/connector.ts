/**
 * The connector protocol's wire side: registrations (a TTL-leased Redis key per connector), source and sink tags, and the
 * audio frame format. Pure functions and small classes; the Redis commands live on `Bus` (connector registry and audio
 * streams). Specs: docs/intent/connections/connections-specs.md (CONN-*), event-bus BUS-AUD-*.
 */
import { z } from "zod";
import type { BusEvent } from "./events.js";

export type AudioDirection = "in" | "out";
export type Capability = "audio-in" | "audio-out";
export type Transport = "stream" | "http";

/** The tag grammar of sources and sinks (CONN-TAG-001). */
export const TAG_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
/** Tags that already name something else (CONN-TAG-002). */
export const RESERVED_TAGS: readonly string[] = ["http", "dir", "dashboard", "mouth", "dryrun", "file"];
export const CONNECTOR_ID_PATTERN = TAG_PATTERN;

// The connector protocol constants (BUS-NAT-RS-004), equal to fixtures/contract/constants.json.
export const REGISTRATION_VERSION = 1;
export const FRAME_VERSION = 1;
/** Largest `pcm` field of one frame (CONN-AUD-002). */
export const MAX_FRAME_BYTES = 64 * 1024;
/** `MAXLEN ~` cap per stream direction (CONN-AUD-001). */
export const AUDIO_MAXLEN: Record<AudioDirection, number> = { in: 3000, out: 1500 };
/** Expiry refreshed by every write to an audio stream (CONN-AUD-001). */
export const AUDIO_STREAM_TTL_MS = 60_000;
export const DEFAULT_CONNECTOR_INTERVAL_MS = 5000;
/** A registration expires after this many intervals without a rewrite (CONN-REG-002). */
export const LEASE_INTERVALS = 3;

export const capabilityDirection = (cap: Capability): AudioDirection => (cap === "audio-in" ? "in" : "out");

const Format = z.object({ rate: z.number().int().positive(), channels: z.number().int().positive() });
export type AudioFormat = z.infer<typeof Format>;

const KnownCapability = z.object({
  cap: z.enum(["audio-in", "audio-out"]),
  tag: z.string().regex(TAG_PATTERN),
  format: Format,
  ready: z.boolean(),
  transport: z.enum(["stream", "http"]).default("stream"),
  /** `audio-out` only: the connector obeys a flush frame (CONN-FLUSH-001); absent means it does not. */
  flush: z.boolean().default(false),
});
export interface CapabilityEntry extends z.input<typeof KnownCapability> { transport?: Transport }

const RegistrationSchema = z.object({
  v: z.literal(REGISTRATION_VERSION),
  id: z.string().regex(CONNECTOR_ID_PATTERN),
  kind: z.string(),
  version: z.string(),
  instance: z.string(),
  pid: z.number().int(),
  startedAt: z.number(),
  intervalMs: z.number().int().positive(),
  state: z.string(),
  detail: z.string().default(""),
  capabilities: z.array(z.object({ cap: z.string() }).passthrough()),
});

export interface Registration {
  v: 1; id: string; kind: string; version: string; instance: string; pid: number; startedAt: number;
  intervalMs: number; state: string; detail: string;
  /** Only the capabilities this version knows; unknown ones are dropped on parse (CONN-REG-005). */
  capabilities: Required<CapabilityEntry>[];
}

/** Parse a registration value; `undefined` when it is not valid JSON or not a v1 registration. Unknown capabilities are ignored. */
// @spec CONN-REG-005
export function parseRegistration(raw: string | Buffer | null | undefined): Registration | undefined {
  if (raw === null || raw === undefined) return undefined;
  let json: unknown;
  try { json = JSON.parse(raw.toString()); } catch { return undefined; }
  const reg = RegistrationSchema.safeParse(json);
  if (!reg.success) return undefined;
  const capabilities = reg.data.capabilities.flatMap((c) => {
    const k = KnownCapability.safeParse(c);
    return k.success ? [k.data] : [];
  });
  return { ...reg.data, v: 1, capabilities };
}

/** The live registration (one read of the registry) offering `cap` for `tag`, whether or not it is ready. */
export function findOffer(regs: readonly Registration[], cap: Capability, tag: string): { reg: Registration; cap: Required<CapabilityEntry> } | undefined {
  for (const reg of regs) {
    const c = reg.capabilities.find((x) => x.cap === cap && x.tag === tag);
    if (c) return { reg, cap: c };
  }
  return undefined;
}

/** The tag is usable only while a live registration offers it with `ready` true (CONN-REG-006). */
// @spec CONN-REG-006
export function findReady(regs: readonly Registration[], cap: Capability, tag: string): { reg: Registration; cap: Required<CapabilityEntry> } | undefined {
  const o = findOffer(regs, cap, tag);
  return o && o.cap.ready ? o : undefined;
}

/** `null` when the tag is acceptable, otherwise the reason it is not (CONN-TAG-001, CONN-TAG-002). */
// @spec CONN-TAG-001, CONN-TAG-002, BUS-NAT-RS-005
export function tagProblem(tag: string): string | null {
  if (!TAG_PATTERN.test(tag)) return `tag "${tag}" does not match ${TAG_PATTERN}`;
  if (RESERVED_TAGS.includes(tag)) return `tag "${tag}" is reserved`;
  return null;
}

// ---------------------------------------------------------------- frames

export interface Frame {
  epoch: number;
  seq: number;
  rate: number;
  ch: number;
  pcm: Buffer;
  /** audio.in only */
  spk?: string;
  name?: string;
  /** audio.out only */
  utt?: string;
  last?: boolean;
  /** audio.out only: this frame stops the line `utt`; it carries no audio (`pcm` is empty, CONN-AUD-006). */
  flush?: boolean;
}

/** The stream entry fields of a frame (CONN-AUD-002); a flush frame carries no `pcm` field (CONN-AUD-006). */
// @spec CONN-AUD-002, CONN-AUD-006, BUS-NAT-RS-003
export function encodeFrame(f: Omit<Frame, "pcm"> & { pcm?: Buffer }): (string | Buffer)[] {
  const out: (string | Buffer)[] = ["v", String(FRAME_VERSION), "epoch", String(f.epoch), "seq", String(f.seq), "rate", String(f.rate), "ch", String(f.ch)];
  if (!f.flush) out.push("pcm", f.pcm ?? Buffer.alloc(0));
  if (f.spk !== undefined) out.push("spk", f.spk);
  if (f.name !== undefined) out.push("name", f.name);
  if (f.utt !== undefined) out.push("utt", f.utt);
  if (f.last) out.push("last", "1");
  if (f.flush) out.push("flush", "1");
  return out;
}

export type DecodedFrame = { ok: true; frame: Frame } | { ok: false; reason: string };

/** Decode one entry's field list; never throws (CONN-BP-006). */
// @spec CONN-BP-006, CONN-AUD-002, CONN-AUD-006, BUS-NAT-RS-003
export function decodeFrame(fields: readonly (string | Buffer)[]): DecodedFrame {
  const m = new Map<string, Buffer>();
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const k = fields[i]!.toString();
    const v = fields[i + 1]!;
    m.set(k, Buffer.isBuffer(v) ? v : Buffer.from(v));
  }
  const num = (k: string): number => Number(m.get(k)?.toString());
  if (m.get("v")?.toString() !== String(FRAME_VERSION)) return { ok: false, reason: "version" };
  const flush = m.get("flush")?.toString() === "1";
  const pcm = flush ? Buffer.alloc(0) : m.get("pcm");
  if (!pcm) return { ok: false, reason: "no pcm" };
  if (pcm.length > MAX_FRAME_BYTES) return { ok: false, reason: "too large" };
  if (pcm.length % 2 !== 0) return { ok: false, reason: "odd byte count" };
  const epoch = num("epoch"), seq = num("seq"), rate = num("rate"), ch = num("ch");
  if (![epoch, seq, rate, ch].every((n) => Number.isFinite(n)) || seq < 0 || rate <= 0 || ch <= 0) return { ok: false, reason: "bad header" };
  const frame: Frame = { epoch, seq, rate, ch, pcm };
  const s = (k: string) => m.get(k)?.toString();
  if (m.has("spk")) frame.spk = s("spk");
  if (m.has("name")) frame.name = s("name");
  if (m.has("utt")) frame.utt = s("utt");
  if (s("last") === "1") frame.last = true;
  if (flush) frame.flush = true;
  return { ok: true, frame };
}

/** Numbers frames of one producer: `seq` from 0 within an `epoch` (the producer's start time). */
export class FrameSequencer {
  private seq = 0;
  constructor(readonly epoch: number = Date.now()) {}
  next(): number { return this.seq++; }
}

/**
 * Consumer-side accounting for one stream: drops frames of the wrong format or malformed and counts them, and counts
 * `seq` gaps within an epoch as lost frames (CONN-AUD-003, CONN-BP-003, CONN-BP-006). A new epoch resets the baseline.
 */
export class FrameTracker {
  /** Frames dropped (malformed or wrong format). */
  dropped = 0;
  /** Frames missing from `seq` gaps. */
  lost = 0;
  private epoch: number | undefined;
  private last = -1;
  constructor(private format?: AudioFormat) {}
  /** The expected format (from the registration); frames with another rate or channel count are dropped. */
  setFormat(format: AudioFormat | undefined): void { this.format = format; }

  /** The frame when it is acceptable, otherwise `undefined` (and counted). */
  // @spec CONN-AUD-003, CONN-BP-003, CONN-BP-006
  accept(decoded: DecodedFrame): Frame | undefined {
    if (!decoded.ok) { this.dropped++; return undefined; }
    const f = decoded.frame;
    if (this.format && (f.rate !== this.format.rate || f.ch !== this.format.channels)) { this.dropped++; return undefined; }
    if (f.epoch !== this.epoch) { this.epoch = f.epoch; }
    else if (f.seq > this.last + 1) this.lost += f.seq - this.last - 1;
    this.last = f.seq;
    return f;
  }
  /** `lost 3, dropped 1` style text for a heartbeat detail. */
  summary(): string { return `lost ${this.lost}, dropped ${this.dropped}`; }
}

/** What `Bus.registerConnector` writes and refreshes. */
export interface ConnectorSpec {
  id: string;
  kind: string;
  version: string;
  /** Rewrite period; default 5000. */
  intervalMs?: number;
  /** Capabilities offered now (re-read each tick, so `ready` can change). */
  capabilities: () => CapabilityEntry[];
  /** Registration state and detail now (default `ready`, empty). */
  status?: () => { state: string; detail?: string };
  /** A heartbeat to publish on the same timer (CONN-REG-007). */
  heartbeat?: (reg: Registration) => BusEvent<"service.heartbeat">["data"];
}
