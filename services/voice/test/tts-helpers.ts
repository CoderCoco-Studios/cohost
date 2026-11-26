/**
 * Shared helpers for the TTS engine tests (not a test file: `mise run test` runs `*.test.ts` only).
 * A WAV builder that can write the awkward headers real servers send, an async-iterable chunker, a local `node:http` fake
 * speech server that records every request, and a fake `TtsEngine`.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { TtsAudio, TtsEngine } from "../src/engine.js";

export interface WavOpts {
  rate?: number;
  channels?: number;
  bits?: number;
  tag?: number;
  /** Chunks written between `fmt ` and `data` (each already a full chunk, header included). */
  before?: Buffer[];
  /** Written into the RIFF size field; default the true size. */
  riffSize?: number;
  /** Written into the data size field; default the true size. */
  dataSize?: number;
}

/** `n` frames of 16-bit mono PCM whose sample `i` is `i + 1` (or `fill`), so a dropped or reordered byte shows. */
export const pcm = (frames: number, fill?: number): Buffer => {
  const b = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) b.writeInt16LE(fill ?? ((i % 30000) + 1), i * 2);
  return b;
};

/** A chunk with an arbitrary id and body, padded to an even length when the size is odd, as RIFF says. */
export function chunk(id: string, body: Buffer): Buffer {
  const h = Buffer.alloc(8);
  h.write(id, 0, "ascii");
  h.writeUInt32LE(body.length, 4);
  return Buffer.concat([h, body, body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

/** Header up to and including the `data` chunk header, then the PCM. */
export function wavBytes(data: Buffer, o: WavOpts = {}): Buffer {
  const rate = o.rate ?? 24000, channels = o.channels ?? 1, bits = o.bits ?? 16;
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(o.tag ?? 1, 0); fmt.writeUInt16LE(channels, 2); fmt.writeUInt32LE(rate, 4);
  fmt.writeUInt32LE((rate * channels * bits) / 8, 8); fmt.writeUInt16LE((channels * bits) / 8, 12); fmt.writeUInt16LE(bits, 14);
  const dataHdr = Buffer.alloc(8);
  dataHdr.write("data", 0, "ascii"); dataHdr.writeUInt32LE(o.dataSize ?? data.length, 4);
  const body = Buffer.concat([Buffer.from("WAVE"), chunk("fmt ", fmt), ...(o.before ?? []), dataHdr, data]);
  const riff = Buffer.alloc(8);
  riff.write("RIFF", 0, "ascii"); riff.writeUInt32LE(o.riffSize ?? body.length, 4);
  return Buffer.concat([riff, body]);
}

/** The header of a WAV as a streaming server writes it: placeholder RIFF and data sizes. */
export const streamedHeader = (o: WavOpts = {}): Buffer => wavBytes(Buffer.alloc(0), { riffSize: 0xffffffff, dataSize: 0xffffffff, ...o });

/** Split `buf` into pieces of the given sizes (the last size repeats). */
export function pieces(buf: Buffer, sizes: number[]): Buffer[] {
  const out: Buffer[] = [];
  let at = 0, i = 0;
  while (at < buf.length) {
    const n = sizes[Math.min(i++, sizes.length - 1)]!;
    out.push(buf.subarray(at, at + n));
    at += n;
  }
  return out;
}

export async function* iter(parts: Buffer[]): AsyncIterable<Buffer> { for (const p of parts) yield p; }

export const audioOf = (parts: Buffer[], sampleRate = 24000): TtsAudio => ({ format: { sampleRate, channels: 1, bitDepth: 16 }, chunks: iter(parts) });

export interface Recorded { method: string; url: string; headers: http.IncomingHttpHeaders; body: Buffer }
export interface FakeServer {
  url: string;
  requests: Recorded[];
  /** Order in which things happened, e.g. `start:1`, `end:1`, `close:1` (1-based request number). */
  events: string[];
  inflight: number;
  maxInflight: number;
  close(): Promise<void>;
}

/**
 * A local HTTP server. `handle(req, res, n, body)` answers request number `n`. `inflight` counts requests whose response
 * has not ended and whose connection has not closed.
 */
export async function fakeServer(handle: (req: http.IncomingMessage, res: http.ServerResponse, n: number, body: Buffer) => void | Promise<void>): Promise<FakeServer> {
  const s: FakeServer = { url: "", requests: [], events: [], inflight: 0, maxInflight: 0, close: async () => {} };
  const sockets = new Set<import("node:net").Socket>();
  let count = 0;
  const server = http.createServer(async (req, res) => {
    const n = ++count;
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    s.requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
    s.events.push(`start:${n}`);
    s.inflight++;
    s.maxInflight = Math.max(s.maxInflight, s.inflight);
    let over = false;
    const finish = (what: string) => { s.events.push(`${what}:${n}`); if (!over) { over = true; s.inflight--; } };
    res.once("close", () => finish(res.writableEnded ? "end" : "close"));
    await handle(req, res, n, body);
  });
  server.on("connection", (sock) => { sockets.add(sock); sock.once("close", () => sockets.delete(sock)); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  s.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  s.close = () => new Promise<void>((r) => { for (const sock of sockets) sock.destroy(); server.close(() => r()); });
  return s;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Answer 200 with a whole WAV at once. */
export const sendWav = (res: http.ServerResponse, data: Buffer, o: WavOpts = {}) => { res.writeHead(200, { "content-type": "audio/wav" }); res.end(wavBytes(data, o)); };

/** A hand-written `TtsEngine` for the tests of what sits above the adapters. */
export function fakeEngine(over: Partial<TtsEngine> & { audio?: (text: string) => TtsAudio | Promise<TtsAudio> } = {}): TtsEngine {
  const { audio, ...rest } = over;
  return {
    name: "kokoro",
    concurrency: 2,
    synthesize: async (text) => (audio ? audio(text) : audioOf([pcm(2400)])),
    fingerprint: () => ({ name: "kokoro" }),
    ...rest,
  };
}
