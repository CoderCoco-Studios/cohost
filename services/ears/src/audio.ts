/** PCM helpers: Discord gives us 48 kHz stereo s16le; Whisper wants 16 kHz mono; Discord wants 48k stereo back. */

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

/** Any-rate mono/stereo 16-bit WAV -> 48k stereo s16le raw PCM (for Discord playback). Linear interpolation. */
export function wavToDiscordPcm(wav: Buffer): Buffer {
  const { sampleRate, channels, dataOffset, dataLength } = readWavHeader(wav);
  const inFrames = Math.floor(dataLength / (channels * 2));
  const outFrames = Math.floor((inFrames * 48000) / sampleRate);
  const out = Buffer.alloc(outFrames * 4);
  const ratio = sampleRate / 48000;
  for (let o = 0; o < outFrames; o++) {
    const pos = o * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(inFrames - 1, i0 + 1);
    const frac = pos - i0;
    for (let c = 0; c < 2; c++) {
      const ch = Math.min(c, channels - 1);
      const a = wav.readInt16LE(dataOffset + (i0 * channels + ch) * 2);
      const b = wav.readInt16LE(dataOffset + (i1 * channels + ch) * 2);
      out.writeInt16LE(Math.round(a + (b - a) * frac), (o * 2 + c) * 2);
    }
  }
  return out;
}

export function readWavHeader(buf: Buffer): { sampleRate: number; channels: number; dataOffset: number; dataLength: number } {
  let off = 12;
  let sampleRate = 0, channels = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "fmt ") { channels = buf.readUInt16LE(off + 10); sampleRate = buf.readUInt32LE(off + 12); }
    else if (id === "data") return { sampleRate, channels, dataOffset: off + 8, dataLength: Math.min(size, buf.length - off - 8) };
    off += 8 + size + (size & 1);
  }
  throw new Error("bad wav");
}

export function wavWrap(pcm: Buffer, sampleRate: number, channels: number): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * channels * 2, 28); h.writeUInt16LE(channels * 2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
