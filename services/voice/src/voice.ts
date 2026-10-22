import type http from "node:http";
import type { BusEvent, Publisher } from "@cohost/bus";
import { urls, type Config, type Logger } from "@cohost/config";
import { envelope, parseWav } from "./wav.js";

export const ENVELOPE_HZ = 30;

export interface VoiceDeps {
  bus: Publisher;
  log: Logger;
  /** text → WAV bytes. */
  synth: (text: string) => Promise<Buffer>;
  /** Base URL sinks fetch audio from. */
  publicUrl: string;
}

/** Calls the TTS container (Kokoro-FastAPI, OpenAI-compatible). */
export function kokoroSynth(cfg: Config["voice"]): (text: string) => Promise<Buffer> {
  return async (text) => {
    const res = await fetch(`${urls.tts()}/v1/audio/speech`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "kokoro",
        input: text,
        voice: cfg.voice,
        speed: cfg.speed,
        response_format: "wav",
      }),
    });
    if (!res.ok) throw new Error(`tts ${res.status}: ${await res.text()}`);
    return Buffer.from(await res.arrayBuffer());
  };
}

/** The voice region: synthesis, the bounded audio store, the virtual sink and the audio HTTP endpoint. */
export class Voice {
  // ---- audio store (in-memory, bounded)
  private store = new Map<string, Buffer>();
  private order: string[] = [];
  // ---- virtual sink bookkeeping
  private claimed = new Set<string>();

  constructor(private d: VoiceDeps) {}

  private put(id: string, wav: Buffer) {
    this.store.set(id, wav);
    this.order.push(id);
    while (this.order.length > 50) this.store.delete(this.order.shift()!);
  }

  async onEvent(ev: BusEvent): Promise<void> {
    if (ev.type === "brain.say") await this.onSay(ev as BusEvent<"brain.say">);
    else if (ev.type === "voice.playing") {
      const d = ev.data as BusEvent<"voice.playing">["data"];
      if (d.sink !== "virtual") this.claimed.add(d.id);
    }
  }

  private async onSay(ev: BusEvent<"brain.say">) {
    const { bus, log } = this.d;
    const { id, text, emotion, gesture } = ev.data;
    const t0 = Date.now();
    try {
      const wav = await this.d.synth(text);
      const info = parseWav(wav);
      const env = envelope(wav, info, ENVELOPE_HZ);
      this.put(id, wav);
      log.info({ id, ms: Date.now() - t0, durationMs: Math.round(info.durationMs), text }, "synthesized");
      await bus.publish("voice.utterance", {
        id, text, emotion, gesture,
        durationMs: Math.round(info.durationMs),
        envelopeHz: ENVELOPE_HZ,
        envelope: env,
        audioUrl: `${this.d.publicUrl}/audio/${id}.wav`,
        sampleRate: info.sampleRate,
      });
      // Virtual sink: if nobody starts playing within 1.5s, time it ourselves.
      setTimeout(async () => {
        if (this.claimed.has(id)) return;
        await bus.publish("voice.playing", { id, sink: "virtual" });
        setTimeout(() => void bus.publish("voice.done", { id, sink: "virtual" }), info.durationMs);
      }, 1500);
    } catch (err) {
      log.error({ err, text }, "tts failed");
      // Let the brain continue even though nothing was said.
      await bus.publish("voice.done", { id, sink: "error" });
    }
  }

  /** HTTP: GET /audio/<id>.wav, GET /health */
  handle = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const m = /^\/audio\/([\w-]+)\.wav$/.exec(req.url ?? "");
    if (m) {
      const wav = this.store.get(m[1]!);
      if (!wav) { res.writeHead(404); res.end("gone"); return; }
      res.writeHead(200, { "content-type": "audio/wav", "content-length": wav.length, "access-control-allow-origin": "*" });
      res.end(wav);
      return;
    }
    if (req.url === "/health") { res.writeHead(200); res.end("ok"); return; }
    res.writeHead(404); res.end();
  };
}
