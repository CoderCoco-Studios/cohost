/**
 * The `kyutai` streaming engine (EARS-KYU-*): `moshi-server` serving Kyutai STT over its ASR WebSocket, MessagePack messages.
 * The server advances only on audio, so the session keeps the stream supplied (80 ms of zero fill while frames pause), sends
 * 24 kHz float32 audio, reads each `Word` once, and flushes an utterance with silence and a `Marker`. Its semantic end of
 * turn (`Step` probabilities) is signalled to the connector source, which closes the utterance (EARS-KYU-008..013).
 */
import WebSocket from "ws";
import { decode, encode } from "@msgpack/msgpack";
import { resample } from "@cohost/shared";
import { SttCapacityError, wsUrl, type EarsConfig, type SttSession, type StreamingSttEngine } from "./engines.js";

const PATH = "/api/asr-streaming";
/** The connect's auth header and the token sent when `ears.kyutai.api_key` is empty (the upstream example's default). */
const AUTH_HEADER = "kyutai-api-key";
const PUBLIC_TOKEN = "public_token";
/** The server's answer when it has no free channel for a stream (moshi-server batched_asr.rs). */
const NO_FREE_CHANNELS = "no free channels";
const OUT_RATE = 24000;
/** Silence fill: 80 ms of zeros whenever no frame has arrived for 80 ms (EARS-KYU-003). */
const FILL_MS = 80;
const FILL_SAMPLES = (OUT_RATE * FILL_MS) / 1000;
/** The silence the server must have received after the last real audio before the Marker (EARS-KYU-006). */
const FLUSH_SILENCE_SAMPLES = (OUT_RATE * 600) / 1000;

/** A `Step` probability is the third of four: the pause of 2 s. */
const EOT_PROBABILITY_INDEX = 2;

const toBuffer = (data: WebSocket.RawData): Buffer => {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
};

const parse = (data: WebSocket.RawData): Record<string, unknown> | undefined => {
  try { return decode(toBuffer(data)) as Record<string, unknown>; } catch { return undefined; }
};

/** 16 kHz s16le mono to 24 kHz float32 in -1..1 (the shared `resample`, then a scale). */
function toFloat24k(pcm16k: Buffer): number[] {
  const up = resample(pcm16k, { from: { rate: 16000, channels: 1 }, to: { rate: OUT_RATE, channels: 1 } });
  const n = up.length >> 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = up.readInt16LE(i * 2) / 32768;
  return Array.from(out);
}

// @spec EARS-KYU-001, EARS-KYU-002, EARS-KYU-003, EARS-KYU-004, EARS-KYU-005, EARS-KYU-006, EARS-KYU-007, EARS-KYU-008, EARS-KYU-009, EARS-KYU-013, EARS-KYU-014
/** The `kyutai` engine: a session per utterance, no readiness probe (the server has none on this route). */
export function createKyutaiEngine(cfg: EarsConfig): StreamingSttEngine {
  const base = cfg.kyutai.url.replace(/\/+$/, "");
  const key = cfg.kyutai.api_key === "" ? PUBLIC_TOKEN : cfg.kyutai.api_key;
  const eot = {
    // @spec EARS-KYU-008, EARS-KYU-013: blank is off
    on: cfg.kyutai.end_of_turn === "on",
    threshold: cfg.kyutai.end_of_turn_threshold,
    // @spec EARS-KYU-009: never under the gap engine, where no frame is classified as speech
    gap: cfg.vad.engine === "gap",
  };
  const bound = cfg.stt_timeout_ms;
  let host: string | undefined;
  try { host = new URL(base).host; } catch { host = undefined; }

  return {
    kind: "streaming",
    name: "kyutai",
    ...(host === undefined ? {} : { destination: host }),
    open: ({ signal }) => openSession(wsUrl(base, PATH), key, bound, eot.on && !eot.gap ? eot : undefined, signal),
  };
}

/** The end-of-turn rule the session applies; absent when the engine does not signal one. */
type EotOptions = { threshold: number };

// @spec EARS-KYU-001, EARS-KYU-014, EARS-SES-009
/** Connects with the key header and waits for `Ready`. The no-free-channel answer is a capacity refusal; any other failure is an outage. */
function openSession(url: string, key: string, bound: number, eot: EotOptions | undefined, signal: AbortSignal): Promise<SttSession> {
  return new Promise<SttSession>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new Error("kyutai open aborted"));
    const ws = new WebSocket(url, { headers: { [AUTH_HEADER]: key } });
    let settled = false;
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      ws.terminate();
      reject(err);
    };
    const onAbort = (): void => fail(signal.reason instanceof Error ? signal.reason : new Error("kyutai open aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    ws.on("error", (err) => fail(err));
    ws.on("close", () => fail(new Error("kyutai connection closed before Ready")));
    ws.on("message", (data) => {
      if (settled) return;
      const ev = parse(data);
      if (ev?.type === "Error") {
        const message = String(ev.message ?? "");
        return fail(message === NO_FREE_CHANNELS ? new SttCapacityError(message) : new Error(`kyutai: ${message}`));
      }
      if (ev?.type !== "Ready") return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(new KyutaiSession(ws, bound, eot));
    });
  });
}

/** One utterance on one stream; never reused. */
class KyutaiSession implements SttSession {
  readonly failed: Promise<Error>;
  private signalFailed!: (err: Error) => void;
  private state: "live" | "flushing" | "ended" = "live";
  private hypothesis = "";
  private hypothesisCb: ((text: string) => void) | undefined;
  private endCb: (() => void) | undefined;
  private wordSeen = false;
  private eotFired = false;
  /** Samples of zeros sent since the last real audio, fill included. */
  private zerosSinceReal = 0;
  /** Fill starts 80 ms after Ready, as if a frame had arrived at Ready. */
  private lastFrameAt = Date.now();
  private fillTimer: ReturnType<typeof setInterval>;
  private markerId = 0;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private resolveFinal: ((text: string) => void) | undefined;
  private rejectFinal: ((err: Error) => void) | undefined;

  constructor(private readonly ws: WebSocket, private readonly bound: number, private readonly eot: EotOptions | undefined) {
    this.failed = new Promise<Error>((res) => { this.signalFailed = res; });
    ws.on("message", (data) => this.onMessage(data));
    ws.on("error", (err) => this.fail(err));
    ws.on("close", () => this.fail(new Error("kyutai connection closed")));
    // the fill timer: the stream is supplied while the session is open and through the flush
    this.fillTimer = setInterval(() => this.tick(), FILL_MS);
    this.fillTimer.unref();
  }

  // @spec EARS-KYU-002, EARS-KYU-004
  push(pcm: Buffer): void {
    if (this.state !== "live" || this.ws.readyState !== WebSocket.OPEN) return;
    this.lastFrameAt = Date.now();
    this.send(toFloat24k(pcm));
    this.zerosSinceReal = 0;
  }

  onHypothesis(cb: (text: string) => void): void { this.hypothesisCb = cb; }
  onEndOfTurn(cb: () => void): void { this.endCb = cb; }

  // @spec EARS-KYU-006, EARS-KYU-007
  finish(): Promise<string> {
    if (this.state !== "live") return Promise.reject(new Error("kyutai session is not open for finish()"));
    this.state = "flushing";
    const final = new Promise<string>((resolve, reject) => { this.resolveFinal = resolve; this.rejectFinal = reject; });
    const shortfall = Math.max(0, FLUSH_SILENCE_SAMPLES - this.zerosSinceReal);
    if (shortfall > 0) this.sendSilence(shortfall);
    this.markerId += 1;
    this.sendMessage({ type: "Marker", id: this.markerId });
    this.flushTimer = setTimeout(() => {
      // a Marker never echoed is not a failure: the words so far are the final (EARS-KYU-007)
      this.finishWith(this.hypothesis);
    }, this.bound);
    return final;
  }

  abort(): void {
    if (this.state === "ended") return;
    this.state = "ended";
    this.clearTimers();
    this.rejectFinal?.(new Error("kyutai session aborted"));
    this.ws.terminate();
  }

  private onMessage(data: WebSocket.RawData): void {
    if (this.state === "ended") return;
    const ev = parse(data);
    if (!ev) return;
    switch (ev.type) {
      // @spec EARS-KYU-005
      case "Word": {
        const text = typeof ev.text === "string" ? ev.text : "";
        this.hypothesis = this.hypothesis === "" ? text : `${this.hypothesis} ${text}`;
        this.wordSeen = true;
        this.hypothesisCb?.(this.hypothesis);
        return;
      }
      case "Step":
        return this.onStep(ev.prs);
      // @spec EARS-KYU-006
      case "Marker":
        if (this.state === "flushing" && ev.id === this.markerId) this.finishWith(this.hypothesis);
        return;
      // @spec EARS-KYU-014
      case "Error":
        this.fail(new Error(`kyutai: ${String(ev.message ?? "server error")}`));
        return;
      default:
        return; // EndWord and anything else: ignored
    }
  }

  // @spec EARS-KYU-008, EARS-KYU-009
  private onStep(prs: unknown): void {
    if (!this.eot || this.state !== "live" || this.eotFired || !this.wordSeen || !Array.isArray(prs)) return;
    const p = Number(prs[EOT_PROBABILITY_INDEX]);
    if (!(p > this.eot.threshold)) return;
    this.eotFired = true;
    this.endCb?.();
  }

  // @spec EARS-KYU-003
  private tick(): void {
    if (this.state === "ended") return;
    // the flush keeps the silence flowing until the Marker is echoed (EARS-KYU-006)
    if (this.state === "flushing" || Date.now() - this.lastFrameAt >= FILL_MS) this.sendSilence(FILL_SAMPLES);
  }

  private sendSilence(samples: number): void {
    this.send(new Array<number>(samples).fill(0));
    this.zerosSinceReal += samples;
  }

  private send(samples: number[]): void {
    this.sendMessage({ type: "Audio", pcm: samples });
  }

  private sendMessage(msg: Record<string, unknown>): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    // float32 on the wire: the server reads Vec<f32> and a float64 array would not be taken as one
    this.ws.send(encode(msg, { forceFloat32: true }), { binary: true });
  }

  private finishWith(text: string): void {
    if (this.state === "ended") return;
    this.state = "ended";
    this.clearTimers();
    this.resolveFinal?.(text);
    this.ws.close();
  }

  private clearTimers(): void {
    clearInterval(this.fillTimer);
    clearTimeout(this.flushTimer);
  }

  // @spec EARS-KYU-014
  private fail(err: Error): void {
    if (this.state === "ended") return;
    this.state = "ended";
    this.clearTimers();
    this.ws.terminate();
    this.signalFailed(err);
    this.rejectFinal?.(err);
  }
}
