/**
 * Connector-mode driver for scripts/dev/perf-baseline.sh (CTRL-LAT-030). Registers a test connector for one source tag
 * with the bus registrar (as every real connector does), writes a WAV clip onto `audio.in.<tag>` as 16 kHz mono frames
 * of 20 ms paced at real time, then silence, and deletes the registration on exit.
 *
 *   node --import tsx scripts/dev/perf-connector.ts <clip.wav> [--tag perf]
 *
 * REDIS_URL defaults to redis://127.0.0.1:6379. ears must have `perf` in ears.sources (the script sets it through
 * COHOST_ISOLATION), and the stack must be up before this runs: a frame written before ears reads the stream is lost.
 */
import { readFileSync } from "node:fs";
import { Bus, ConnectorRegistrar, FrameSequencer, type Frame } from "../../packages/bus/src/index.js";
import { parseWav, resample } from "../../packages/shared/src/index.js";

// @spec CTRL-LAT-030
const RATE = 16000;
const FRAME_MS = 20;
const FRAME_BYTES = (RATE * FRAME_MS / 1000) * 2; // mono s16le
const SETTLE_MS = 6000; // ears polls the registry about every 5 s; the clip starts after it has seen the source
const SILENCE_MS = 2000; // longer than ears.silence_ms, so ears closes the utterance by its own rule

const args = process.argv.slice(2);
const tagAt = args.indexOf("--tag");
const tag = tagAt >= 0 ? args[tagAt + 1] ?? "" : "perf";
const clipPath = args.find((a, i) => !a.startsWith("--") && (tagAt < 0 || i !== tagAt + 1));
if (!clipPath || !tag) {
  console.error("usage: perf-connector.ts <clip.wav> [--tag perf]");
  process.exit(2);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The clip as 16 kHz mono s16le PCM. */
function clipPcm(): Buffer {
  const buf = readFileSync(clipPath!);
  const info = parseWav(buf);
  const pcm = buf.subarray(info.dataOffset, info.dataOffset + info.dataLength);
  return resample(pcm, { from: { rate: info.sampleRate, channels: info.channels }, to: { rate: RATE, channels: 1 } });
}

const bus = new Bus("perf-connector");
const registrar = new ConnectorRegistrar(bus, {
  id: tag,
  kind: "perf",
  version: "1",
  capabilities: () => [{ cap: "audio-in", tag, format: { rate: RATE, channels: 1 }, ready: true }],
});

// Deregisters the connector once, whether the run ends or the operator interrupts it (CTRL-LAT-030).
let closed: Promise<void> | undefined;
const close = (): Promise<void> => (closed ??= registrar.stop().then(() => bus.stop()));
process.once("SIGINT", () => { void close().finally(() => process.exit(130)); });

try {
  const pcm = clipPcm();
  await registrar.start();
  await sleep(SETTLE_MS);

  const seq = new FrameSequencer();
  const stream = Buffer.concat([pcm, Buffer.alloc(Math.ceil((SILENCE_MS * RATE) / 1000) * 2)]);
  const start = Date.now();
  let sent = 0;
  for (let off = 0; off < stream.length; off += FRAME_BYTES, sent++) {
    const due = start + sent * FRAME_MS;
    if (Date.now() < due) await sleep(due - Date.now());
    const frame: Frame = {
      epoch: seq.epoch, seq: seq.next(), rate: RATE, ch: 1,
      pcm: stream.subarray(off, Math.min(off + FRAME_BYTES, stream.length)), spk: tag, name: tag,
    };
    await bus.publishFrame("in", tag, frame);
  }
  console.log(`perf-connector: ${sent} frames (${(stream.length / 2 / RATE * 1000).toFixed(0)} ms, ${SILENCE_MS} ms silence) onto audio.in.${tag}`);
} finally {
  await close();
}
