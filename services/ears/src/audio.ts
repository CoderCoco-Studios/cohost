/** PCM helpers: Discord gives us 48 kHz stereo s16le; Whisper wants 16 kHz mono. */
import { parseWav, wavWrap } from "@cohost/shared";

// @spec EARS-AUD-001
/** 48k stereo s16le -> 16k mono s16le WAV (for STT). Simple 3:1 decimation with averaging. */
export function discordPcmToWav16k(pcm: Buffer): Buffer {
  const inFrames = Math.floor(pcm.length / 4);
  const outFrames = Math.floor(inFrames / 3);
  const out = Buffer.alloc(outFrames * 2);
  for (let o = 0; o < outFrames; o++) {
    let acc = 0;
    for (let k = 0; k < 3; k++) {
      const i = (o * 3 + k) * 4;
      acc += (pcm.readInt16LE(i) + pcm.readInt16LE(i + 2)) / 2;
    }
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(acc / 3))), o * 2);
  }
  return wavWrap(out, 16000, 1);
}

// @spec EARS-AUD-003
/** Thin adapter over the shared `parseWav`: no RIFF/WAVE check, and any failure reads as `bad wav`. */
export function readWavHeader(buf: Buffer): { sampleRate: number; channels: number; dataOffset: number; dataLength: number } {
  try {
    const { sampleRate, channels, dataOffset, dataLength } = parseWav(buf, { requireRiff: false });
    return { sampleRate, channels, dataOffset, dataLength };
  } catch {
    throw new Error("bad wav");
  }
}
