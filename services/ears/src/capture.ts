/**
 * The capture-source contract. A capture source owns how audio arrives (a connector's audio stream, an HTTP POST, a dropped
 * file) and hands each finished clip to the one `Hearing` path; transcription, filtering and `speech.heard` stay there.
 */
import { parseWav } from "@cohost/shared";

/** Signed 16-bit little-endian PCM with its format. */
export interface Clip {
  pcm: Buffer;
  rate: number;
  channels: number;
  /** Epoch ms the audio ended: a connector's last frame arrival, or when a clip source received the clip (EARS-HEAR-012). */
  audioEndedAt?: number;
  /** Minted when the utterance opened (connector source); `Hearing` mints one for a whole clip (EARS-PART-003). */
  utteranceId?: string;
}

/** What `Hearing.heardClip` did: published a transcript, or the reason it published nothing. */
export type HearOutcome =
  | { heard: true; text: string }
  | { heard: false; reason: "too-short" | "empty" | "drop-phrase" | "stt-error" | "echo" };

/** The sink every adapter feeds: one clip, one speaker name, the name of the source it came from and, when the source tells speakers apart, the speaker's id. */
export type HearClip = (clip: Clip, speaker: string, source?: string, speakerId?: string) => Promise<HearOutcome>;

/** A listening source. `start` resolves once audio can arrive; `stop` waits for the clip in flight. */
export interface CaptureAdapter {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** `ok` while the listener is bound or the directory is being polled. */
  status(): "ok" | "down";
}

/** Why an uploaded clip was refused: a content type ears does not read, or bytes that do not decode as 16-bit PCM. */
export class ClipError extends Error {
  constructor(readonly code: "unsupported-type" | "bad-audio", message: string) {
    super(message);
    this.name = "ClipError";
  }
}

const WAV_TYPES = new Set(["audio/wav", "audio/x-wav", "audio/wave"]);
const PCM_TYPES = new Set(["audio/l16", "audio/pcm"]);

// @spec EARS-CAP-002
/**
 * Bytes plus content type to a clip: WAV through the shared `parseWav` (16-bit only), or raw s16le PCM whose `rate` and
 * `channels` parameters default to 16000 and 1. Throws `ClipError`.
 */
export function decodeClip(buf: Buffer, contentType: string): Clip {
  const [rawType = "", ...params] = contentType.split(";");
  const type = rawType.trim().toLowerCase();
  if (WAV_TYPES.has(type)) {
    try {
      const w = parseWav(buf);
      return { pcm: buf.subarray(w.dataOffset, w.dataOffset + w.dataLength), rate: w.sampleRate, channels: w.channels };
    } catch (err) {
      throw new ClipError("bad-audio", err instanceof Error ? err.message : String(err));
    }
  }
  if (PCM_TYPES.has(type)) {
    const p = new Map(params.map((kv) => { const [k = "", v = ""] = kv.split("="); return [k.trim().toLowerCase(), v.trim()] as const; }));
    const rate = p.has("rate") ? Number(p.get("rate")) : 16000;
    const channels = p.has("channels") ? Number(p.get("channels")) : 1;
    if (!Number.isInteger(rate) || rate < 1 || rate > 384_000) throw new ClipError("bad-audio", `bad rate '${p.get("rate")}'`);
    if (!Number.isInteger(channels) || channels < 1 || channels > 8) throw new ClipError("bad-audio", `bad channels '${p.get("channels")}'`);
    if (buf.length < channels * 2) throw new ClipError("bad-audio", "no audio");
    return { pcm: buf.subarray(0, buf.length - (buf.length % (channels * 2))), rate, channels };
  }
  throw new ClipError("unsupported-type", `unsupported content type '${type}'`);
}
