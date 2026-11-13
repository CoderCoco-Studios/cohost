import type { Frame, FrameSequencer } from "@cohost/bus";
import { resample, type PcmFormat } from "./audio.js";

export interface UtteranceWriterOptions {
  /** Appends one frame to the sink's stream (`Bus.publishFrame("out", tag, frame)`). */
  write(frame: Frame): Promise<unknown>;
  /** Numbers the frames of this writer's epoch. */
  sequencer: FrameSequencer;
  /** The sink's declared format (its registration's `format`). */
  format: PcmFormat;
  /** Length of one frame, ms (default 20). */
  frameMs?: number;
  /** How far ahead of real time the writer may run, ms (default 1000). */
  leadMs?: number;
  /** Checked before each frame: when it returns true the rest of the line is not written (an abandoned line). */
  abort?: () => boolean;
  /** Replacements for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Write one utterance's audio to a sink stream: convert it to the sink's format with `resample`, cut it into 20 ms
 * frames tagged `utt`, mark the last frame `last`, and write no faster than real time plus a lead of one second, so
 * the sink's stream cap and the connector's player are never fed a burst. A frame whose write fails is skipped and
 * the rest still goes out (a connector tolerates gaps). Resolves with the number of frames written.
 */
// @spec CONN-AUD-005, CONN-BP-004
export async function writeUtterance(
  o: UtteranceWriterOptions,
  line: { utt: string; pcm: Buffer; from: PcmFormat },
): Promise<number> {
  const frameMs = o.frameMs ?? 20;
  const leadMs = o.leadMs ?? 1000;
  const now = o.now ?? (() => performance.now());
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const converted = resample(line.pcm, { from: line.from, to: o.format });
  const frameBytes = Math.max(1, Math.round((o.format.rate * frameMs) / 1000)) * o.format.channels * 2;
  const count = Math.max(1, Math.ceil(converted.length / frameBytes));
  const start = now();
  let written = 0;
  for (let i = 0; i < count; i++) {
    if (o.abort?.()) break;
    const wait = start + i * frameMs - leadMs - now();
    if (wait > 0) await sleep(wait);
    if (o.abort?.()) break;
    const frame: Frame = {
      epoch: o.sequencer.epoch, seq: o.sequencer.next(), rate: o.format.rate, ch: o.format.channels,
      pcm: converted.subarray(i * frameBytes, (i + 1) * frameBytes), utt: line.utt,
    };
    if (i === count - 1) frame.last = true;
    try { await o.write(frame); written++; } catch { /* skipped: the stream tolerates a gap */ }
  }
  return written;
}
