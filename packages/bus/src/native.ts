/**
 * The adapter from the native addon to `BusTransport`, and the only file that imports the addon (BUS-NAT-API-010).
 * Loads `../native/cohost-bus.<platform>-<arch>-gnu.node` relative to this file and nothing else: no search path, no
 * environment override, no fallback transport (BUS-NAT-BLD-004). The binding's types are declared here, so no file the
 * napi CLI generates is needed (BUS-NAT-BLD-009). linux-x64-gnu is the only target (BUS-NAT-BLD-006).
 */
import { createRequire } from "node:module";
import type { AudioDirection, DecodedFrame, Frame } from "./connector.js";
import type { BusTransport, TransportFactory } from "./transport.js";

/** What `crates/cohost-bus-node` exports. Every I/O method of the transport it creates returns a Promise. */
interface Binding {
  /** Begins opening the shared connection without blocking or throwing, even when Redis is unreachable (BUS-NAT-TRN-004). */
  Transport: new (url: string, prefix: string, failFast: boolean) => BusTransport;
  encodeFrame(frame: Frame): (string | Buffer)[];
  decodeFrame(fields: readonly (string | Buffer)[]): DecodedFrame;
  tagProblem(tag: string): string | null;
  connectorKey(prefix: string, id: string): string;
  audioStream(prefix: string, dir: AudioDirection, tag: string): string;
  /** Source of `TAG_PATTERN`. */
  TAG_PATTERN: string;
  reservedTags(): string[];
  FRAME_VERSION: number;
  MAX_FRAME_BYTES: number;
  AUDIO_MAXLEN_IN: number;
  AUDIO_MAXLEN_OUT: number;
  AUDIO_STREAM_TTL_MS: number;
  LEASE_INTERVALS: number;
  REGISTRATION_VERSION: number;
  DEFAULT_CONNECTOR_INTERVAL_MS: number;
  HEALTH_MAXLEN: number;
}

// @spec BUS-NAT-BLD-004, BUS-NAT-BLD-005
function load(): Binding {
  const { platform, arch } = process;
  const file = `cohost-bus.${platform}-${arch}-gnu.node`;
  const path = new URL(`../native/${file}`, import.meta.url).pathname;
  const fail = (why: string, cause?: unknown): never => {
    throw Object.assign(
      new Error(`@cohost/bus cannot load the native addon (${why}): looked for ${file} for platform ${platform}, arch ${arch} at ${path}. Build it with \`pnpm build:native\`.`, { cause }),
      { code: "BUS_INTERNAL" },
    );
  };
  if (platform !== "linux" || arch !== "x64") return fail("only linux-x64-gnu is supported");
  try {
    return createRequire(import.meta.url)(path) as Binding;
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err), err);
  }
}

const binding = load();

/** Production default of `BusOptions.transport` (BUS-NAT-API-003). */
export const createNativeTransport: TransportFactory = (url, opts) => new binding.Transport(url, opts.prefix, opts.failFast);

// @spec BUS-NAT-RS-003, BUS-NAT-TRN-013
/** A flush frame carries no audio (CONN-AUD-006): its absent `pcm` is passed to the binding as an empty one, which it does not write. */
export const encodeFrame = (frame: Frame): (string | Buffer)[] => binding.encodeFrame(frame.pcm ? frame : { ...frame, pcm: Buffer.alloc(0) });
export const decodeFrame = binding.decodeFrame;
// @spec BUS-NAT-RS-005
export const tagProblem = binding.tagProblem;
export const TAG_PATTERN = new RegExp(binding.TAG_PATTERN);
export const RESERVED_TAGS: readonly string[] = binding.reservedTags();
// @spec BUS-NAT-RS-006
export const connectorKey = binding.connectorKey;
export const audioStream = binding.audioStream;
// @spec BUS-NAT-RS-004
export const FRAME_VERSION = binding.FRAME_VERSION;
export const MAX_FRAME_BYTES = binding.MAX_FRAME_BYTES;
export const AUDIO_MAXLEN: Record<AudioDirection, number> = { in: binding.AUDIO_MAXLEN_IN, out: binding.AUDIO_MAXLEN_OUT };
export const AUDIO_STREAM_TTL_MS = binding.AUDIO_STREAM_TTL_MS;
export const LEASE_INTERVALS = binding.LEASE_INTERVALS;
export const REGISTRATION_VERSION = binding.REGISTRATION_VERSION;
export const DEFAULT_CONNECTOR_INTERVAL_MS = binding.DEFAULT_CONNECTOR_INTERVAL_MS;
export const HEALTH_MAXLEN = binding.HEALTH_MAXLEN;
