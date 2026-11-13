/** The speech-activity detector seam of EARS-VAD-*: one detector per speaker id, loaded once per connector source. */
import { fileURLToPath } from "node:url";

/** Speech probability (0 to 1) of one 16 kHz mono s16le frame; stateful, so each speaker id has its own instance. */
export interface SpeechDetector {
  probability(pcm: Buffer): number | Promise<number>;
}

/** Loads the detector once and returns the factory that makes one `SpeechDetector` per speaker id; rejects when it cannot load. */
export type LoadVad = () => Promise<() => SpeechDetector>;

/** The Silero VAD v5 model shipped with ears (`models/README.md` records its source, tag and checksum). */
export const SILERO_MODEL_PATH = fileURLToPath(new URL("../models/silero_vad.onnx", import.meta.url));

/** Silero v5 at 16 kHz reads 512-sample windows, each prefixed with the last 64 samples of the one before. */
const WINDOW = 512;
const CONTEXT = 64;

type Ort = typeof import("onnxruntime-node");
type Session = import("onnxruntime-node").InferenceSession;

/** One speaker's recurrent state, context and the samples not yet filling a window. */
class SileroSpeaker implements SpeechDetector {
  private state = new Float32Array(2 * 1 * 128);
  private context = new Float32Array(CONTEXT);
  private pending = new Float32Array(0);
  private last = 0;
  constructor(private ort: Ort, private session: Session) {}

  async probability(pcm: Buffer): Promise<number> {
    const n = pcm.length >> 1;
    const joined = new Float32Array(this.pending.length + n);
    joined.set(this.pending);
    for (let i = 0; i < n; i++) joined[this.pending.length + i] = pcm.readInt16LE(i * 2) / 32768;
    let at = 0;
    for (; joined.length - at >= WINDOW; at += WINDOW) {
      const input = new Float32Array(CONTEXT + WINDOW);
      input.set(this.context);
      input.set(joined.subarray(at, at + WINDOW), CONTEXT);
      const out = await this.session.run({
        input: new this.ort.Tensor("float32", input, [1, input.length]),
        state: new this.ort.Tensor("float32", this.state, [2, 1, 128]),
        sr: new this.ort.Tensor("int64", BigInt64Array.from([16000n]), []),
      });
      this.last = (out.output!.data as Float32Array)[0]!;
      this.state = Float32Array.from(out.stateN!.data as Float32Array);
      this.context = joined.slice(at + WINDOW - CONTEXT, at + WINDOW);
    }
    this.pending = joined.slice(at);
    return this.last;
  }
}

// @spec EARS-VAD-002, EARS-VAD-006, EARS-VAD-007
/**
 * The production loader for `ears.vad.engine: silero`: loads `onnxruntime-node` and the model once, and returns a factory
 * of independent per-speaker detectors. Rejects with the reason when the runtime or the model cannot load, which marks
 * the source down (no fallback to `gap`).
 */
export async function loadSilero(modelPath: string = SILERO_MODEL_PATH): Promise<() => SpeechDetector> {
  let ort: Ort;
  try { ort = await import("onnxruntime-node"); } catch (err) { throw new Error(`onnxruntime-node did not load: ${err instanceof Error ? err.message : String(err)}`); }
  let session: Session;
  try { session = await ort.InferenceSession.create(modelPath); } catch (err) { throw new Error(`Silero model ${modelPath} did not load: ${err instanceof Error ? err.message : String(err)}`); }
  return () => new SileroSpeaker(ort, session);
}
