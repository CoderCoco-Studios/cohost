/**
 * The `nemotron` streaming engine: NeMo-Speech.cpp serving Nemotron Speech Streaming over its realtime WebSocket. One
 * WebSocket per utterance: binary PCM16 frames at 16 kHz go up as they arrive, `input_audio_buffer.commit` asks for the final,
 * and the final is the `completed` segments up to `input_audio_buffer.committed`. The session publishes no partial: the
 * `delta` events are ignored (EARS-NEM-004).
 */
import WebSocket from "ws";
import { wsUrl, type EarsConfig, type SttSession, type StreamingSttEngine } from "./engines.js";

const REALTIME_PATH = "/v1/audio/transcriptions/realtime";
const READY_PATH = "/ready";
/** The bound on a final is this far under `ears.stt_timeout_ms`, so the adapter gives up before the router does. */
const FLUSH_MARGIN_MS = 20;

const parse = (data: WebSocket.RawData): Record<string, unknown> | undefined => {
  try { return JSON.parse(data.toString()) as Record<string, unknown>; } catch { return undefined; }
};

/** The message of an `error` event: `{ type: "error", error: { message } }` (NeMo-Speech.cpp docs/api.md). */
const errorText = (ev: Record<string, unknown>): string => {
  const e = ev.error as { message?: unknown } | undefined;
  return typeof e?.message === "string" ? e.message : "nemotron server error";
};

/** Where `ears.nemotron.url` points, as a host for `destination` (no scheme, no path). */
const hostOf = (url: string): string | undefined => {
  try { return new URL(url).host; } catch { return undefined; }
};

// @spec EARS-NEM-001, EARS-NEM-002, EARS-NEM-003, EARS-NEM-004, EARS-NEM-005, EARS-NEM-006, EARS-NEM-007
/** The `nemotron` engine: a session per utterance, a readiness probe on `GET /ready`. */
export function createNemotronEngine(cfg: EarsConfig): StreamingSttEngine {
  const base = cfg.nemotron.url.replace(/\/+$/, "");
  const key = cfg.nemotron.api_key;
  const bound = Math.max(1, cfg.stt_timeout_ms - FLUSH_MARGIN_MS);
  const host = hostOf(base);

  return {
    kind: "streaming",
    name: "nemotron",
    ...(host === undefined ? {} : { destination: host }),
    async ping(signal: AbortSignal): Promise<boolean> {
      try {
        const res = await fetch(`${base}${READY_PATH}`, { signal });
        return res.ok;
      } catch {
        return false;
      }
    },
    open: ({ signal }) => openSession(wsUrl(base, REALTIME_PATH), key, bound, signal),
  };
}

/** Connects, waits for `session.created`, and resolves the session; any failure before then rejects (an outage). */
function openSession(url: string, key: string, bound: number, signal: AbortSignal): Promise<SttSession> {
  return new Promise<SttSession>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new Error("nemotron open aborted"));
    const ws = new WebSocket(url, key === "" ? {} : { headers: { authorization: `Bearer ${key}` } });
    let settled = false;
    const onAbort = (): void => fail(signal.reason ?? new Error("nemotron open aborted"));
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      ws.terminate();
      reject(err);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    ws.on("error", (err) => fail(err));
    ws.on("close", () => fail(new Error("nemotron connection closed before session.created")));
    ws.on("message", (data) => {
      const ev = parse(data);
      if (ev?.type === "error") return fail(new Error(errorText(ev)));
      if (ev?.type !== "session.created" || settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(new NemotronSession(ws, bound));
    });
  });
}

/** One utterance on one connection; never reused (EARS-NEM-005). */
class NemotronSession implements SttSession {
  readonly failed: Promise<Error>;
  private signalFailed!: (err: Error) => void;
  /** The `completed` segments of this utterance, in order. */
  private segments: string[] = [];
  private finishing = false;
  private ended = false;
  private resolveFinal: ((text: string) => void) | undefined;
  private rejectFinal: ((err: Error) => void) | undefined;
  private finalTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly ws: WebSocket, private readonly bound: number) {
    this.failed = new Promise<Error>((res) => { this.signalFailed = res; });
    ws.on("message", (data) => this.onMessage(data));
    ws.on("error", (err) => this.fail(err));
    ws.on("close", () => this.fail(new Error("nemotron connection closed")));
  }

  push(pcm: Buffer): void {
    // a socket that is not open is reported by its close event, not here
    if (this.ws.readyState !== WebSocket.OPEN || this.ended) return;
    this.ws.send(pcm, { binary: true });
  }

  /** No partials are published: the wire carries no flag telling a suffix from a corrected whole text (EARS-NEM-004). */
  onHypothesis(): void {}
  /** The engine signals no end of turn. */
  onEndOfTurn(): void {}

  finish(): Promise<string> {
    if (this.ended) return Promise.reject(new Error("nemotron session already ended"));
    if (this.finishing) return Promise.reject(new Error("nemotron finish already called"));
    this.finishing = true;
    if (this.ws.readyState !== WebSocket.OPEN) {
      const err = new Error("nemotron connection closed before finish()");
      this.fail(err);
      return Promise.reject(err);
    }
    const final = new Promise<string>((resolve, reject) => { this.resolveFinal = resolve; this.rejectFinal = reject; });
    this.finalTimer = setTimeout(() => {
      // a final that does not come is a failed session (EARS-NEM-006); the socket is dropped, not closed politely
      this.fail(new Error(`nemotron final did not arrive after ${this.bound} ms`));
    }, this.bound);
    this.ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    return final;
  }

  abort(): void {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.finalTimer);
    this.rejectFinal?.(new Error("nemotron session aborted"));
    this.ws.terminate();
  }

  private onMessage(data: WebSocket.RawData): void {
    if (this.ended) return;
    const ev = parse(data);
    if (!ev) return;
    switch (ev.type) {
      case "conversation.item.input_audio_transcription.completed": {
        // a completed event is a final segment; one before the commit is a segment the server endpointed on
        const text = typeof ev.transcript === "string" ? ev.transcript.trim() : "";
        if (text !== "") this.segments.push(text);
        return;
      }
      case "input_audio_buffer.committed":
        // the server sends this after every commit; an empty utterance has no completed event and an empty final
        if (!this.finishing) return;
        this.end(this.segments.join(" "));
        return;
      case "error":
        this.fail(new Error(errorText(ev)));
        return;
      default:
        return; // delta events are ignored (EARS-NEM-004)
    }
  }

  /** The utterance is over on purpose: the final was taken, so the close is no failure. */
  private end(text: string): void {
    this.ended = true;
    clearTimeout(this.finalTimer);
    this.ws.close();
    this.resolveFinal?.(text);
  }

  /** A failure of the session, whether an error event, a drop or a final that does not arrive (EARS-NEM-006). */
  private fail(err: Error): void {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.finalTimer);
    this.ws.terminate();
    this.signalFailed(err);
    this.rejectFinal?.(err);
  }
}
