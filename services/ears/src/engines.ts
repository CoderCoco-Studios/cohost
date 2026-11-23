/**
 * The speech-to-text engine contract and its selection (EARS-ENG-*). A batch engine takes a whole clip (`speaches`,
 * `openai`, `stub`); a streaming engine takes frames as they arrive and opens one session per utterance (`nemotron`,
 * `kyutai`; their wire protocols are the adapters of #188). Every call an engine makes is bounded by `ears.stt_timeout_ms`.
 */
import { urls, type Config } from "@cohost/config";
import { wavDurationMs } from "./audio.js";

export type EarsConfig = Config["ears"];

/** The re-probe period of a streaming engine with a readiness probe while it is down (EARS-HLTH-008). */
export const STT_PING_INTERVAL_MS = 10_000;

/** The reason a whole clip fails when no batch engine is configured (EARS-ENG-005). */
export const NO_BATCH_ENGINE = "no batch STT engine";

/** A server that answers that it has no free channel for a session (EARS-SES-009). */
export class SttCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SttCapacityError";
  }
}

/** A batch request the server answered with a failed status. */
export class SttRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "SttRequestError";
  }
}

// @spec EARS-ENG-009
/** Outage class (EARS-ENG-009): every failure except a 400 or 422 answer for one clip. */
export function isOutage(err: unknown): boolean {
  if (err instanceof SttRequestError) return err.status !== 400 && err.status !== 422;
  return true;
}

/** Rejects with `what after ms` when `p` has not settled within `ms`; a late settle of `p` is ignored. */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} after ${ms} ms`)), ms); });
  return Promise.race([p, bound]).finally(() => clearTimeout(timer));
}

/** One utterance's speech-to-text session of a streaming engine (EARS-SES-*). */
export interface SttSession {
  /** Sends one 16 kHz mono s16le frame, in order. */
  push(pcm: Buffer): void;
  /** The whole hypothesis so far, each time it changes (EARS-PART-016). */
  onHypothesis(cb: (text: string) => void): void;
  onEndOfTurn(cb: () => void): void;
  /** The final text, once the utterance is closed. */
  finish(): Promise<string>;
  /** Drops the session without a final. */
  abort(): void;
  /** Settles with the error when the session fails before `finish()`. */
  readonly failed: Promise<Error>;
}

export interface BatchSttEngine {
  readonly kind: "batch";
  readonly name: "speaches" | "openai" | "stub";
  /** The host the engine sends audio to; absent for `stub`. */
  readonly destination?: string;
  /** Set when the engine's configuration is incomplete (EARS-ENG-010). */
  readonly gap?: string;
  transcribe(audio: Buffer, hint?: { contentType: string }): Promise<string>;
}

export interface StreamingSttEngine {
  readonly kind: "streaming";
  readonly name: "nemotron" | "kyutai";
  readonly destination?: string;
  /** Readiness probe (EARS-HLTH-008); absent when the engine has none. Aborted by `signal` when the probe times out. */
  ping?(signal: AbortSignal): Promise<boolean>;
  /** Resolves when the server is connected and ready for audio. Aborted by `signal` on timeout or source stop. Rejects with `SttCapacityError` for a capacity refusal, with any other error for an outage. */
  open(opts: { signal: AbortSignal }): Promise<SttSession>;
}

export type SttEngine = BatchSttEngine | StreamingSttEngine;

const EXT: Record<string, string> = {
  "audio/wav": "wav", "audio/x-wav": "wav", "audio/mpeg": "mp3", "audio/ogg": "ogg", "audio/webm": "webm", "audio/mp4": "mp4",
};

const hostOf = (url: string): string => {
  try { return new URL(url).host; } catch { return url; }
};

// @spec EARS-HEAR-005, EARS-ENG-006, EARS-ENG-007, EARS-ENG-008, EARS-STUB-001, EARS-ENG-012
/** A batch engine by name: `speaches` (its `/v1` transcription route), `openai` (`ears.openai`), or `stub` (no network). */
export function createBatchEngine(name: BatchSttEngine["name"], cfg: EarsConfig): BatchSttEngine {
  if (name === "stub") {
    return { kind: "batch", name, transcribe: async (audio) => `stub transcript (${wavDurationMs(audio)} ms)` };
  }
  const base = name === "speaches" ? urls.stt() : cfg.openai.base_url.replace(/\/+$/, "");
  const gap = name === "openai" && base === "" ? "ears.openai.base_url is not set" : undefined;
  const endpoint = name === "speaches" ? `${base}/v1/audio/transcriptions` : `${base}/audio/transcriptions`;
  const key = name === "openai" ? cfg.openai.api_key : "";
  return {
    kind: "batch", name, destination: gap === undefined ? hostOf(base) : undefined, ...(gap ? { gap } : {}),
    async transcribe(audio, hint) {
      if (gap) throw new Error(gap);
      const type = hint?.contentType.split(";")[0]?.trim() || "audio/wav";
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(audio)], { type }), `speech.${EXT[type] ?? "wav"}`);
      form.append("model", cfg.stt_model);
      form.append("language", "en");
      form.append("response_format", "json");
      const headers: Record<string, string> = key !== "" ? { authorization: `Bearer ${key}` } : {};
      const post = async (): Promise<string> => {
        const res = await fetch(endpoint, { method: "POST", body: form, headers, signal: AbortSignal.timeout(cfg.stt_timeout_ms) });
        if (!res.ok) throw new SttRequestError(res.status, `${name} ${res.status}: ${(await res.text()).slice(0, 200)}`);
        const json = (await res.json()) as { text?: string };
        return (json.text ?? "").trim();
      };
      return withTimeout(post(), cfg.stt_timeout_ms, `${name} transcription did not answer`);
    },
  };
}

/** A streaming engine name with no adapter built in this process; its session open is an outage. #188 builds the adapters. */
function unbuiltStreaming(name: StreamingSttEngine["name"]): StreamingSttEngine {
  return { kind: "streaming", name, open: async () => { throw new Error(`${name} streaming adapter is not built`); } };
}

export interface BuiltEngines {
  /** The engine `ears.stt_engine` names. */
  selected: SttEngine;
  /** The batch engine of EARS-ENG-003; absent when there is none. */
  batch?: BatchSttEngine;
  /** The configuration gap of the selected engine or the batch engine (EARS-ENG-010), the first one found. */
  gap?: string;
  /** The gap of the selected engine alone. */
  selectedGap?: string;
  /** The host the selected engine talks to. */
  host: string;
}

// @spec EARS-ENG-001, EARS-ENG-002, EARS-ENG-003, EARS-ENG-010, EARS-ENG-012
/**
 * Builds the selected engine and the batch engine. A streaming engine is the `streaming` engine handed in (#188 builds
 * the real ones); without one the engine's sessions cannot open.
 */
export function buildEngines(cfg: EarsConfig, o: { streaming?: StreamingSttEngine } = {}): BuiltEngines {
  const name = cfg.stt_engine || "speaches";
  if (name === "speaches" || name === "openai" || name === "stub") {
    const selected = createBatchEngine(name, cfg);
    return { selected, batch: selected, ...(selected.gap ? { gap: selected.gap, selectedGap: selected.gap } : {}), host: selected.destination ?? "" };
  }
  const url = name === "nemotron" ? cfg.nemotron.url : cfg.kyutai.url;
  const selectedGap = url === "" ? `ears.${name}.url is not set` : undefined;
  const selected = o.streaming ?? unbuiltStreaming(name);
  const fallback = cfg.stt_fallback_engine || "speaches";
  const batch = fallback === "none" ? undefined : createBatchEngine(fallback, cfg);
  const gap = selectedGap ?? batch?.gap;
  return {
    selected, ...(batch ? { batch } : {}), ...(gap ? { gap } : {}), ...(selectedGap ? { selectedGap } : {}),
    host: selected.destination ?? hostOf(url),
  };
}
