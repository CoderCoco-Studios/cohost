/**
 * Stand-in for the Kokoro TTS container, so `voice` (and the avatar lip-sync,
 * and the dashboard sink) run with no GPU and no model download.
 *
 *   node --import tsx scripts/dev/stub-tts.ts            # listens on :8880
 *   TTS_URL=http://127.0.0.1:8880 node --import tsx services/voice/src/index.ts
 *
 * Answers POST /v1/audio/speech with a 24 kHz mono 16-bit WAV: a quiet
 * pulsing tone lasting ~65 ms per character, so the mouth envelope moves.
 */
import http from "node:http";

const PORT = Number(process.env.STUB_TTS_PORT ?? 8880);
const RATE = 24_000;

function wav(text: string): Buffer {
  const secs = Math.min(8, Math.max(0.4, text.length * 0.065));
  const n = Math.floor(RATE * secs);
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const amp = 0.25 * (0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * t)); // 4 Hz "syllables"
    pcm.writeInt16LE(Math.round(amp * Math.sin(2 * Math.PI * 220 * t) * 32767), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/v1/audio/speech") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let text = "";
      try { text = String(JSON.parse(body).input ?? ""); } catch { /* empty text -> shortest clip */ }
      console.log(`tts: ${JSON.stringify(text.slice(0, 60))}`);
      res.writeHead(200, { "content-type": "audio/wav" });
      res.end(wav(text));
    });
  } else {
    res.writeHead(404);
    res.end();
  }
}).listen(PORT, () => console.log(`stub tts on :${PORT}`));
