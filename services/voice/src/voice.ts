import type http from "node:http";
import type { BusEvent, Publisher } from "@cohost/bus";
import { urls, type Config, type Logger } from "@cohost/config";
import { parseWav, wavWrap } from "@cohost/shared";
import { envelope } from "./wav.js";
import type { ClipRoutes } from "./clips.js";

export const ENVELOPE_HZ = 30;

export interface VoiceDeps {
  bus: Publisher;
  log: Logger;
  /** text → WAV bytes. */
  synth: (text: string) => Promise<Buffer>;
  /** Base URL sinks fetch audio from. */
  publicUrl: string;
  /** The fallback clip store behind `/fallback/*`; absent (the stub engine) means those routes answer 404. */
  clips?: ClipRoutes;
}

/** A non-2xx reply from the TTS server; the message stays `tts <status>: <body>`. */
export class TtsError extends Error {
  constructor(readonly status: number, body: string) { super(`tts ${status}: ${body}`); this.name = "TtsError"; }
}

/** Everything the Kokoro synthesizer sends to the TTS server except the text; the clip fingerprint hashes it (VOICE-CLIP-001). */
export function kokoroRequestSettings(cfg: Pick<Config["voice"], "voice" | "speed">): Record<string, unknown> {
  return { model: "kokoro", voice: cfg.voice, speed: cfg.speed, response_format: "wav" };
}

/** Calls the TTS container (Kokoro-FastAPI, OpenAI-compatible). */
export function kokoroSynth(cfg: Config["voice"]): (text: string) => Promise<Buffer> { // @spec VOICE-SYN-002
  return async (text) => {
    const res = await fetch(`${urls.tts()}/v1/audio/speech`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...kokoroRequestSettings(cfg), input: text }),
    });
    if (!res.ok) throw new TtsError(res.status, await res.text()); // @spec VOICE-SYN-003
    return Buffer.from(await res.arrayBuffer());
  };
}

/** Stub timing: 60 ms of silence per character, never shorter than 400 ms. */
export const STUB_MS_PER_CHAR = 60;
export const STUB_MIN_MS = 400;

/** `voice.engine: stub` — a silent mono PCM16 WAV sized from the text. No network. */
export function stubSynth(cfg: Pick<Config["voice"], "sample_rate">): (text: string) => Promise<Buffer> { // @spec VOICE-STUB-001
  return async (text) => {
    const ms = Math.max(STUB_MIN_MS, text.length * STUB_MS_PER_CHAR);
    const frames = Math.round((cfg.sample_rate * ms) / 1000);
    return wavWrap(Buffer.alloc(frames * 2), cfg.sample_rate, 1); // zero-filled = silence
  };
}

/** The voice region: synthesis, the bounded audio store, the virtual sink and the audio HTTP endpoint. */
export class Voice {
  // ---- audio store (in-memory, bounded)
  private store = new Map<string, Buffer>();
  private order: string[] = [];
  // ---- virtual sink bookkeeping
  /** Ids a real sink has claimed; only ids whose audio is stored, so it is bounded by the store. */
  private claimed = new Set<string>();
  /** Pending virtual `voice.done` timers, keyed by utterance id; a late real sink cancels its entry. */
  private virtualDone = new Map<string, NodeJS.Timeout>();
  /** Where an utterance is in the virtual sink: waiting out its claim window, or publishing the virtual `voice.playing`. */
  private phase = new Map<string, "window" | "publishing">();
  /** Ids a sink gave up on (a `voice.failed` without fallback) before the window ended or the virtual `voice.playing` finished publishing. */
  private givenUp = new Set<string>();

  constructor(private d: VoiceDeps) {}

  private put(id: string, wav: Buffer) { // @spec VOICE-HTTP-001
    this.store.set(id, wav);
    this.order.push(id);
    while (this.order.length > 50) {
      const evicted = this.order.shift()!;
      this.store.delete(evicted);
      this.claimed.delete(evicted); // @spec VOICE-SINK-007
      this.givenUp.delete(evicted);
    }
  }

  /** Number of live real-sink claims (never more than the audio store holds). */
  get claimCount(): number { return this.claimed.size; }

  /** Publish a virtual-sink event; a failure is logged and never escapes the timer callback. */
  private async publishVirtual(type: "voice.playing" | "voice.done", id: string): Promise<void> { // @spec VOICE-SINK-009
    try {
      await this.d.bus.publish(type, { id, sink: "virtual" });
    } catch (err) {
      this.d.log.warn({ err, id, type }, "virtual sink publish failed");
    }
  }

  /**
   * Publish the virtual `voice.playing`, then time `voice.done` from when that publish resolved, so a slow publish never
   * lets the done arrive back-to-back with the playing. A real sink that claimed the id during the publish wins: no
   * done is armed. A failed publish is logged inside `publishVirtual` and the done is still armed.
   */
  private async playVirtual(id: string, durationMs: number): Promise<void> { // @spec VOICE-SINK-003, VOICE-SINK-008, VOICE-SINK-012
    this.phase.set(id, "publishing");
    await this.publishVirtual("voice.playing", id);
    this.phase.delete(id);
    const reported = this.givenUp.delete(id);
    if (this.claimed.has(id)) return;
    if (reported) { // a sink gave up on the line meanwhile: release at once instead of waiting out its duration
      await this.publishVirtual("voice.done", id);
      return;
    }
    clearTimeout(this.virtualDone.get(id));
    this.virtualDone.set(id, setTimeout(() => {
      this.virtualDone.delete(id);
      void this.publishVirtual("voice.done", id);
    }, durationMs));
  }

  async onEvent(ev: BusEvent): Promise<void> {
    if (ev.type === "brain.say") await this.onSay(ev as BusEvent<"brain.say">);
    else if (ev.type === "voice.failed") await this.onFailed(ev as BusEvent<"voice.failed">);
    else if (ev.type === "voice.playing") {
      const d = ev.data as BusEvent<"voice.playing">["data"];
      if (d.sink === "virtual") return; // @spec VOICE-SINK-005
      if (this.store.has(d.id)) this.claimed.add(d.id); // @spec VOICE-SINK-001, VOICE-SINK-007
      // A real sink that starts after voice's virtual pair began takes over: the virtual done must not release the brain early.
      const pending = this.virtualDone.get(d.id);
      if (pending) { clearTimeout(pending); this.virtualDone.delete(d.id); } // @spec VOICE-SINK-008
    }
  }

  /**
   * A sink gave up on an utterance. Nothing to do when a fallback clip plays in its place, a real sink holds the id, or the
   * audio is not stored; otherwise cortex is released without waiting for the line's duration.
   */
  private async onFailed(ev: BusEvent<"voice.failed">): Promise<void> { // @spec VOICE-SINK-010, VOICE-SINK-011, VOICE-SINK-012, VOICE-SINK-013
    const { id, fallback } = ev.data;
    if (fallback || this.claimed.has(id) || !this.store.has(id)) return;
    if (this.phase.has(id)) { this.givenUp.add(id); return; } // acted on when the window ends / the virtual playing publish resolves
    const pending = this.virtualDone.get(id);
    if (!pending) return; // the virtual done was already published
    clearTimeout(pending);
    this.virtualDone.delete(id);
    await this.publishVirtual("voice.done", id);
  }

  private async onSay(ev: BusEvent<"brain.say">) { // @spec VOICE-SYN-004, VOICE-SYN-005, VOICE-UTT-001
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
        audioUrl: `${this.d.publicUrl}/audio/${id}.wav`, // @spec VOICE-UTT-002
        sampleRate: info.sampleRate,
      });
      // Virtual sink: if nobody starts playing within 1.5s, time it ourselves.
      this.phase.set(id, "window");
      setTimeout(() => { // @spec VOICE-SINK-002, VOICE-SINK-004, VOICE-SINK-011
        this.phase.delete(id);
        const reported = this.givenUp.delete(id);
        if (this.claimed.has(id)) return;
        // A sink gave up on this line and nobody claimed it: release cortex now, with no virtual playing.
        if (reported) { void this.publishVirtual("voice.done", id); return; }
        void this.playVirtual(id, info.durationMs);
      }, 1500);
    } catch (err) { // @spec VOICE-UTT-003, VOICE-SINK-006
      log.error({ err, text }, "tts failed");
      // Let the brain continue even though nothing was said.
      await bus.publish("voice.done", { id, sink: "error" });
    }
  }

  /** HTTP: GET /audio/<id>.wav, GET /fallback/manifest.json, GET /fallback/<name>, GET /health */
  handle = (req: http.IncomingMessage, res: http.ServerResponse): void => { // @spec VOICE-HTTP-002, VOICE-HTTP-003, VOICE-HTTP-004, VOICE-CLIP-008, VOICE-CLIP-011, VOICE-CLIP-012
    const m = /^\/audio\/([\w-]+)\.wav$/.exec(req.url ?? "");
    if (m) {
      const wav = this.store.get(m[1]!);
      if (!wav) { res.writeHead(404); res.end("gone"); return; }
      res.writeHead(200, { "content-type": "audio/wav", "content-length": wav.length, "access-control-allow-origin": "*" });
      res.end(wav);
      return;
    }
    const clips = this.d.clips;
    if (clips && req.url === "/fallback/manifest.json") {
      const manifest = clips.manifest();
      if (!manifest) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(manifest));
      return;
    }
    const clip = clips ? /^\/fallback\/([\w][\w.-]*)$/.exec(req.url ?? "") : null;
    if (clips && clip) {
      void clips.clipBytes(clip[1]!).then((wav) => {
        if (!wav) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { "content-type": "audio/wav", "content-length": wav.length });
        res.end(wav);
      });
      return;
    }
    if (req.url === "/health") { res.writeHead(200); res.end("ok"); return; }
    res.writeHead(404); res.end();
  };
}
