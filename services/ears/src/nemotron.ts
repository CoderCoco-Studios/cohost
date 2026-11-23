/**
 * The `nemotron` streaming engine (EARS-NEM-*): NeMo-Speech.cpp serving Nemotron Speech Streaming over its realtime WebSocket.
 * One WebSocket per utterance: binary PCM16 frames at 16 kHz go up as they arrive, `delta` events build the hypothesis, and
 * `input_audio_buffer.commit` asks for the final, which is the `completed` event's transcript.
 */
import WebSocket from "ws";
import { wsUrl, type EarsConfig, type SttSession, type StreamingSttEngine } from "./engines.js";

const REALTIME_PATH = "/v1/audio/transcriptions/realtime";
const READY_PATH = "/ready";

const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Where `ears.nemotron.url` points, as a host for `destination` (no scheme, no path). */
const hostOf = (url: string): string | undefined => {
  try { return new URL(url).host; } catch { return undefined; }
};

// @spec EARS-NEM-001, EARS-NEM-002, EARS-NEM-003, EARS-NEM-004, EARS-NEM-005, EARS-NEM-006, EARS-NEM-007
/** The `nemotron` engine: a session per utterance, a readiness probe on `GET /ready`. */
export function createNemotronEngine(cfg: EarsConfig): StreamingSttEngine {
  const base = cfg.nemotron.url.replace(/\/+$/, "");
  const key = cfg.nemotron.api_key;
  const bound = cfg.stt_timeout_ms;
  const host = hostOf(base);

  return {
    kind: "streaming",
    name: "nemotron",
    ...(host === undefined ? {} : { destination: host }),
    // @spec EARS-NEM-007
    async ping(signal: AbortSignal): Promise<boolean> {
      try {
        const res = await fetch(`${base}${READY_PATH}`, { signal });
        return res.ok;
      } catch {
        return false;
      }
    },
    // @spec EARS-NEM-001, EARS-NEM-002
    open: ({ signal }) => openSession(wsUrl(base, REALTIME_PATH), key, bound, signal),
  };
}

// @spec EARS-NEM-001, EARS-NEM-002, EARS-NEM-006
/** Connects, waits for `session.created`, and resolves the session; any failure before then rejects (an outage, not a capacity refusal). */
function openSession(url: string, key: string, bound: number, signal: AbortSignal): Promise<SttSession> {
  return new Promise<SttSession>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new Error("nemotron open aborted"));
    const ws = new WebSocket(url, key === "" ? {} : { headers: { authorization: `Bearer ${key}` } });
    let settled = false;
    const onAbort = (): void => {
      if (!settled) { settled = true; ws.terminate(); reject(signal.reason ?? new Error("nemotron open aborted")); }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      ws.terminate();
      reject(err);
    };
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

const parse = (data: WebSocket.RawData): Record<string, unknown> | undefined => {
  try { return JSON.parse(data.toString()) as Record<string, unknown>; } catch { return undefined; }
};

/** The message of an `error` event: `{ type: "error", error: { message } }` (NeMo-Speech.cpp docs/api.md). */
const errorText = (ev: Record<string, unknown>): string => {
  const e = ev.error as { message?: unknown } | undefined;
  return typeof e?.message === "string" ? e.message : "nemotron server error";
};

/** One utterance on one connection; never reused (EARS-NEM-005). */
class NemotronSession implements SttSession {
  readonly failed: Promise<Error>;
  private signalFailed!: (err: Error) => void;
  private hypothesis = "";
  /** The final segments the server has completed for this utterance, in order. */
  private segments: string[] = [];
  private hypothesisCb: ((text: string) => void) | undefined;
  private endCb: (() => void) | undefined;
  /** Set once `finish()` has been called or the session ended on purpose. */
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

  onHypothesis(cb: (text: string) => void): void { this.hypothesisCb = cb; }
  onEndOfTurn(cb: () => void): void { this.endCb = cb; }

  // @spec EARS-NEM-005, EARS-NEM-006
  finish(): Promise<string> {
    if (this.ended) return Promise.reject(new Error("nemotron session already ended"));
    if (this.finishing) return Promise.reject(new Error("nemotron finish already called"));
    this.finishing = true;
    if (this.ws.readyState !== WebSocket.OPEN) {
      this.fail(new Error("nemotron connection closed before finish()"));
      return Promise.reject(new Error("nemotron connection closed before finish()"));
    }
    const final = new Promise<string>((resolve, reject) => { this.resolveFinal = resolve; this.rejectFinal = reject; });
    this.finalTimer = setTimeout(() => {
      this.rejectFinal?.(new Error(`nemotron final did not arrive after ${this.bound} ms`));
      this.ws.close();
      this.ended = true;
    }, this.bound);
    this.ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    return final;
  }

  abort(): void {
    this.ended = true;
    clearTimeout(this.finalTimer);
    this.rejectFinal?.(new Error("nemotron session aborted"));
    this.ws.terminate();
  }

  private onMessage(data: WebSocket.RawData): void {
    const ev = parse(data);
    if (!ev || this.ended) return;
    switch (ev.type) {
      case "conversation.item.input_audio_transcription.delta": {
        const delta = typeof ev.delta === "string" ? ev.delta : "";
        // @spec EARS-NEM-004: a delta that starts with the hypothesis is the whole corrected text; any other is a suffix.
        // A suffix that begins with the whole previous hypothesis is read as a replacement (the known limit).
        this.hypothesis = this.hypothesis !== "" && delta.startsWith(this.hypothesis) ? delta : this.hypothesis + delta;
        this.hypothesisCb?.(this.hypothesis);
        return;
      }
      case "conversation.item.input_audio_transcription.completed": {
        // @spec EARS-NEM-005: a completed event is a final segment; the server ends an utterance with a
        // committed event, which follows the commit's own completed event when there is one. A completed event
        // before the commit is a segment the server endpointed on, and the utterance continues.
        const text = typeof ev.transcript === "string" ? ev.transcript.trim() : "";
        if (text !== "") this.segments.push(text);
        this.hypothesis = "";
        return;
      }
      case "input_audio_buffer.committed":
        // @spec EARS-NEM-005: an empty utterance has no completed event, so its final is the empty text
        if (!this.finishing) return;
        this.end();
        this.resolveFinal?.(this.segments.join(" "));
        return;
      case "error":
        this.fail(new Error(errorText(ev)));
        return;
      default:
        return;
    }
  }

  /** The utterance is over on purpose: the final was taken, so the close is no failure. */
  private end(): void {
    this.ended = true;
    clearTimeout(this.finalTimer);
    this.ws.close();
  }

  // @spec EARS-NEM-006
  private fail(err: Error): void {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.finalTimer);
    this.ws.terminate();
    this.signalFailed(err);
    this.rejectFinal?.(err);
  }
}
