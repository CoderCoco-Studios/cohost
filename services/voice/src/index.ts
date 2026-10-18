/**
 * voice — turns `brain.say` into audio.
 *
 * Calls the TTS container (Kokoro-FastAPI, OpenAI-compatible), computes a
 * mouth envelope for lip-sync, keeps the WAV in memory and serves it over
 * HTTP so any "sink" (dashboard audio page captured by OBS, the Discord bot)
 * can fetch and play it. Sinks report `voice.playing` / `voice.done`; if no
 * sink picks an utterance up, a virtual sink times it so the brain moves on.
 */
import http from "node:http";
import { Bus, onShutdown, type BusEvent } from "@cohost/bus";
import { createLogger, envOr, loadConfig, urls } from "@cohost/config";
import { envelope, parseWav } from "./wav.js";

const log = createLogger("voice");
const cfg = loadConfig();
const bus = new Bus("voice", log);
const PORT = Number(envOr("VOICE_PORT", "8700"));
const PUBLIC = envOr("VOICE_URL", `http://voice:${PORT}`);
const ENVELOPE_HZ = 30;

// ---- audio store (in-memory, bounded)
const store = new Map<string, Buffer>();
const order: string[] = [];
function put(id: string, wav: Buffer) {
  store.set(id, wav);
  order.push(id);
  while (order.length > 50) store.delete(order.shift()!);
}

// ---- virtual sink bookkeeping
const claimed = new Set<string>();

async function synth(text: string): Promise<Buffer> {
  const res = await fetch(`${urls.tts()}/v1/audio/speech`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "kokoro",
      input: text,
      voice: cfg.voice.voice,
      speed: cfg.voice.speed,
      response_format: "wav",
    }),
  });
  if (!res.ok) throw new Error(`tts ${res.status}: ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

async function onSay(ev: BusEvent<"brain.say">) {
  const { id, text, emotion, gesture } = ev.data;
  const t0 = Date.now();
  try {
    const wav = await synth(text);
    const info = parseWav(wav);
    const env = envelope(wav, info, ENVELOPE_HZ);
    put(id, wav);
    log.info({ id, ms: Date.now() - t0, durationMs: Math.round(info.durationMs), text }, "synthesized");
    await bus.publish("voice.utterance", {
      id, text, emotion, gesture,
      durationMs: Math.round(info.durationMs),
      envelopeHz: ENVELOPE_HZ,
      envelope: env,
      audioUrl: `${PUBLIC}/audio/${id}.wav`,
      sampleRate: info.sampleRate,
    });
    // Virtual sink: if nobody starts playing within 1.5s, time it ourselves.
    setTimeout(async () => {
      if (claimed.has(id)) return;
      await bus.publish("voice.playing", { id, sink: "virtual" });
      setTimeout(() => void bus.publish("voice.done", { id, sink: "virtual" }), info.durationMs);
    }, 1500);
  } catch (err) {
    log.error({ err, text }, "tts failed");
    // Let the brain continue even though nothing was said.
    await bus.publish("voice.done", { id, sink: "error" });
  }
}

// ---- HTTP: GET /audio/<id>.wav, GET /health
const server = http.createServer((req, res) => {
  const m = /^\/audio\/([\w-]+)\.wav$/.exec(req.url ?? "");
  if (m) {
    const wav = store.get(m[1]!);
    if (!wav) { res.writeHead(404); res.end("gone"); return; }
    res.writeHead(200, { "content-type": "audio/wav", "content-length": wav.length, "access-control-allow-origin": "*" });
    res.end(wav);
    return;
  }
  if (req.url === "/health") { res.writeHead(200); res.end("ok"); return; }
  res.writeHead(404); res.end();
});
server.listen(PORT, () => log.info({ port: PORT, public: PUBLIC, voice: cfg.voice.voice }, "voice online"));

void bus.subscribe({ group: "voice", types: ["brain.say", "voice.playing"], fromNow: true }, async (ev) => {
  if (ev.type === "brain.say") await onSay(ev as BusEvent<"brain.say">);
  else if (ev.type === "voice.playing") {
    const d = ev.data as BusEvent<"voice.playing">["data"];
    if (d.sink !== "virtual") claimed.add(d.id);
  }
});

onShutdown(() => { server.close(); bus.stop(); });
