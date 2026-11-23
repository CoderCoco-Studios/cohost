/**
 * The TTS engine contract: one interface every speech server adapter implements (kokoro, openai, pocket, stub), the
 * whole-clip collector, the concurrency gate shared by lines and clip phrases, and the one failure classification.
 * See the voice LLD, The TTS engine contract.
 */
import { wavWrap } from "@cohost/shared";

/** A line outranks a clip phrase for the gate (VOICE-ENG-012). */
export type Priority = "line" | "clip";

/** The audio an engine returns: raw signed 16-bit little-endian PCM in whole frames, in order, with its stated format. */
export interface TtsAudio {
  format: { sampleRate: number; channels: 1; bitDepth: 16 };
  /** Rejects if the connection fails before the audio ends. */
  chunks: AsyncIterable<Buffer>;
}

export interface SynthesizeOpts {
  signal: AbortSignal;
  priority?: Priority;
  /** True once a `voice.stop` named the line: its outcome, success or failure, moves no health. */
  discarded?: () => boolean;
}

export interface TtsEngine {
  readonly name: "kokoro" | "openai" | "pocket" | "stub";
  /** Most requests the server takes at once; voice never sends more (VOICE-ENG-011). */
  readonly concurrency: number;
  /** Set when the configuration is incomplete: every `synthesize` rejects with it (VOICE-GAP-001). */
  readonly configError?: string;
  /** Host of the server, for the egress note and the heartbeat detail. */
  readonly destination?: string;
  /** Resolves when the server has accepted the request and the audio format is known. */
  synthesize(text: string, opts: SynthesizeOpts): Promise<TtsAudio>;
  /** Everything that decides how a line sounds; the fallback clip fingerprint hashes it. Never a credential. */
  fingerprint(): Record<string, unknown>;
  /** Optional readiness probe; absent where the server has no verified health route. */
  ping?(signal: AbortSignal): Promise<boolean>;
}

/** The synthesis call voice and the clip service make: text to a whole WAV. */
export type Synth = (text: string, o?: { priority?: Priority; signal?: AbortSignal; discarded?: () => boolean }) => Promise<Buffer>;

/** A non-2xx reply from the TTS server; the message stays `tts <status>: <body>`. */
export class TtsError extends Error {
  constructor(readonly status: number, body: string) { super(`tts ${status}: ${body}`); this.name = "TtsError"; }
}

/** The engine answered with audio that holds no frames. */
export class EmptyAudioError extends Error {
  constructor() { super("tts audio: no audio"); this.name = "EmptyAudioError"; }
}

export type FailureClass = "line" | "outage";

/**
 * One classification for health, clip generation and the line. `line`: a 400 or 422 or zero frames, about the one
 * request. `outage`: everything else (connection, timeout, 5xx, 401, 403, 404, 429, rejected audio, incomplete config).
 */
export function classifyFailure(err: unknown): FailureClass { // @spec VOICE-ERR-001, VOICE-ERR-002
  if (err instanceof TtsError) return err.status === 400 || err.status === 422 ? "line" : "outage";
  if (err instanceof EmptyAudioError) return "line";
  return "outage";
}

/** Gather the whole audio and wrap it as a 16-bit mono WAV. Zero frames reject (VOICE-ENG-003). */
export async function collect(audio: TtsAudio): Promise<Buffer> { // @spec VOICE-ENG-001, VOICE-ENG-002, VOICE-ENG-003
  const parts: Buffer[] = [];
  let bytes = 0;
  for await (const c of audio.chunks) {
    if (c.length === 0) continue;
    parts.push(c);
    bytes += c.length;
  }
  if (bytes === 0) throw new EmptyAudioError();
  return wavWrap(Buffer.concat(parts), audio.format.sampleRate, audio.format.channels);
}

/**
 * The concurrency gate: at most `limit` places held. Waiting lines are granted before waiting clip phrases. A place is
 * freed only by its own release, once; a second call does nothing.
 */
export class TtsGate { // @spec VOICE-ENG-011, VOICE-ENG-012, VOICE-ENG-013
  private held = 0;
  private lines: (() => void)[] = [];
  private clips: (() => void)[] = [];

  constructor(private limit: number) {}

  acquire(priority: Priority): Promise<() => void> {
    return new Promise((resolve) => {
      const grant = () => {
        this.held++;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.held--;
          this.next();
        });
      };
      if (this.held < this.limit && this.lines.length + this.clips.length === 0) grant();
      else (priority === "line" ? this.lines : this.clips).push(grant);
    });
  }

  private next(): void {
    if (this.held >= this.limit) return;
    const grant = this.lines.shift() ?? this.clips.shift();
    grant?.();
  }
}
