import type http from "node:http";
import type { BusEvent, Publisher } from "@cohost/bus";
import type { Logger } from "@cohost/config";
import { parseWav } from "@cohost/shared";
import { envelope } from "./wav.js";
import type { ClipRoutes } from "./clips.js";
import type { Synth } from "./engine.js";

export const ENVELOPE_HZ = 30;

export interface VoiceDeps {
  bus: Publisher;
  log: Logger;
  /** Text to a whole WAV, through the engine contract (`engine.ts`). */
  synth: Synth;
  /** Base URL sinks fetch audio from. */
  publicUrl: string;
  /** The fallback clip store behind `/fallback/*`; absent (the stub engine) means those routes answer 404. */
  clips?: ClipRoutes;
}

/** The path of a request target, without its query string; a target that does not parse matches no route. */
function pathOf(target: string | undefined): string {
  try { return new URL(target ?? "/", "http://voice.invalid").pathname; } catch { return ""; }
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
  /** The claim-window timer of each line, by id, so a `voice.stop` can clear it. */
  private windowTimers = new Map<string, NodeJS.Timeout>();
  private phase = new Map<string, "window" | "publishing">();
  /** Ids a sink gave up on (a `voice.failed` without fallback) before the window ended or the virtual `voice.playing` finished publishing. */
  private givenUp = new Set<string>();
  /** Pending claim-window timers; `stop` clears them. */
  private windows = new Set<NodeJS.Timeout>();
  // ---- synthesis queue
  /** `brain.say` events waiting for synthesis, oldest first; handled one at a time off the bus read loop. */
  private queue: BusEvent<"brain.say">[] = [];
  private draining: Promise<void> | undefined;
  private stopped = false;
  /** Aborted at shutdown only: a `voice.stop` never aborts an engine request (VOICE-ENG-014). */
  private abort = new AbortController();
  /** Ids a `voice.stop` ended while their synthesis was running: the result is discarded (VOICE-STOP-004). */
  private cancelled = new Set<string>();
  /** Ids whose virtual `voice.playing` publish was in flight when a `voice.stop` named them (VOICE-STOP-010). */
  private stoppedPublishing = new Set<string>();
  /** The line being synthesized, or whose `voice.utterance` publish is in flight, now. */
  private synthesizing: string | undefined;

  constructor(private d: VoiceDeps) {}

  /** Resolves once every queued `brain.say` has been handled (and immediately when none is queued). */
  async whenIdle(): Promise<void> {
    while (this.draining) await this.draining;
  }

  /**
   * Shut the region down: drop queued lines, stop an in-flight line from publishing or arming timers, and clear the
   * claim-window and virtual-done timers so nothing is published after the bus has stopped.
   */
  stop(): void { // @spec VOICE-SYN-008, VOICE-HLTH-005, VOICE-ENG-015
    this.stopped = true;
    this.abort.abort();
    this.queue.length = 0;
    for (const t of this.windows) clearTimeout(t);
    this.windows.clear();
    for (const t of this.virtualDone.values()) clearTimeout(t);
    this.virtualDone.clear();
  }

  /** Queue a line for synthesis; the loop that reads the bus returns at once (VOICE-SYN-007). */
  private enqueue(ev: BusEvent<"brain.say">): void { // @spec VOICE-SYN-007
    if (this.stopped) return;
    this.queue.push(ev);
    this.draining ??= this.drain();
  }

  private async drain(): Promise<void> {
    try {
      while (!this.stopped) {
        const ev = this.queue.shift();
        if (!ev) break;
        try {
          await this.onSay(ev);
        } catch (err) {
          this.d.log.error({ err, id: ev.data.id }, "synthesis failed");
        }
      }
    } finally {
      this.draining = undefined;
    }
  }

  private put(id: string, wav: Buffer) { // @spec VOICE-HTTP-001, VOICE-HTTP-008
    const at = this.order.indexOf(id);
    if (at >= 0) this.order.splice(at, 1); // a re-used id is the newest entry, once
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
  private async publishVirtual(type: "voice.playing" | "voice.done", id: string, interrupted = false): Promise<void> { // @spec VOICE-SINK-009
    try {
      await this.d.bus.publish(type, { id, seq: 0, sink: "virtual", ...(interrupted ? { interrupted: true as const } : {}) } as never);
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
    const interrupted = this.stoppedPublishing.delete(id);
    if (this.stopped) return;
    const reported = this.givenUp.delete(id);
    if (this.claimed.has(id)) return;
    if (interrupted) { // a voice.stop arrived during the publish; @spec VOICE-STOP-010
      await this.publishVirtual("voice.done", id, true);
      return;
    }
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
    if (ev.type === "brain.say") this.enqueue(ev as BusEvent<"brain.say">);
    else if (ev.type === "voice.failed") await this.onFailed(ev as BusEvent<"voice.failed">);
    else if (ev.type === "voice.stop") await this.onStop(ev as BusEvent<"voice.stop">);
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
   * `voice.stop`: drop the named lines (every line without `ids`) wherever they are: queued, in synthesis, in the claim window
   * or in the virtual playing. A line a real sink claimed is left to that sink (VOICE-STOP-007); later lines are unaffected (VOICE-STOP-008).
   */
  private async onStop(ev: BusEvent<"voice.stop">): Promise<void> { // @spec VOICE-STOP-001, VOICE-STOP-002, VOICE-STOP-003, VOICE-STOP-004, VOICE-STOP-005, VOICE-STOP-006, VOICE-STOP-007, VOICE-STOP-008, VOICE-STOP-009, VOICE-STOP-010
    const ids = ev.data.ids ? new Set(ev.data.ids) : undefined;
    const named = (id: string): boolean => !ids || ids.has(id);
    this.queue = this.queue.filter((q) => !named(q.data.id));
    if (this.synthesizing !== undefined && named(this.synthesizing)) this.cancelled.add(this.synthesizing);
    for (const [id, timer] of [...this.windowTimers]) {
      if (!named(id) || this.claimed.has(id)) continue;
      clearTimeout(timer);
      this.windows.delete(timer);
      this.windowTimers.delete(id);
      this.phase.delete(id);
      this.givenUp.delete(id);
    }
    for (const [id, phase] of [...this.phase]) {
      if (phase !== "publishing" || !named(id) || this.claimed.has(id)) continue;
      this.stoppedPublishing.add(id); // @spec VOICE-STOP-010
      this.givenUp.delete(id);
    }
    for (const [id, timer] of [...this.virtualDone]) {
      if (!named(id)) continue;
      clearTimeout(timer);
      this.virtualDone.delete(id);
      await this.publishVirtual("voice.done", id, true); // @spec VOICE-STOP-006
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

  private async onSay(ev: BusEvent<"brain.say">) { // @spec VOICE-SYN-004, VOICE-SYN-005, VOICE-UTT-001, VOICE-UTT-004
    const { bus, log } = this.d;
    const { id, text, emotion, gesture, route } = ev.data;
    const t0 = Date.now();
    this.synthesizing = id;
    try {
      const wav = await this.d.synth(text, { priority: "line", signal: this.abort.signal, discarded: () => this.stopped || this.cancelled.has(id) }); // @spec VOICE-ENG-001, VOICE-ENG-014
      if (this.stopped) { this.synthesizing = undefined; return; }
      if (this.cancelled.has(id)) { this.synthesizing = undefined; this.cancelled.delete(id); return; } // a voice.stop ended this line while it synthesized; @spec VOICE-STOP-004
      const info = parseWav(wav); // @spec VOICE-ENV-005, VOICE-POC-005
      const env = envelope(wav, info, ENVELOPE_HZ);
      this.put(id, wav);
      log.info({ id, ms: Date.now() - t0, durationMs: Math.round(info.durationMs), text }, "synthesized");
      await bus.publish("voice.utterance", {
        id, seq: 0, text, emotion, gesture, ...(route ? { route } : {}), // @spec VOICE-UTT-004
        durationMs: Math.round(info.durationMs),
        envelopeHz: ENVELOPE_HZ,
        envelope: env,
        audioUrl: `${this.d.publicUrl}/audio/${id}.wav`, // @spec VOICE-UTT-002
        sampleRate: info.sampleRate,
      });
      this.synthesizing = undefined;
      // A voice.stop during the publish discards the line: no claim window, no done; @spec VOICE-STOP-009
      if (this.stopped || this.cancelled.delete(id)) return;
      // Virtual sink: if nobody starts playing within 1.5s, time it ourselves.
      this.phase.set(id, "window");
      const timer = setTimeout(() => { // @spec VOICE-SINK-002, VOICE-SINK-004, VOICE-SINK-011
        this.windows.delete(timer);
        this.windowTimers.delete(id);
        this.phase.delete(id);
        const reported = this.givenUp.delete(id);
        if (this.claimed.has(id)) return;
        // A sink gave up on this line and nobody claimed it: release cortex now, with no virtual playing.
        if (reported) { void this.publishVirtual("voice.done", id); return; }
        void this.playVirtual(id, info.durationMs);
      }, 1500);
      this.windows.add(timer);
      this.windowTimers.set(id, timer);
    } catch (err) {
      this.synthesizing = undefined;
      if (this.cancelled.delete(id)) return; // @spec VOICE-UTT-003, VOICE-SINK-006
      log.error({ err, text }, "tts failed");
      // Let the brain continue even though nothing was said.
      await bus.publish("voice.done", { id, seq: 0, sink: "error" });
    }
  }

  /** HTTP, GET and HEAD only: GET /audio/<id>.wav, GET /fallback/manifest.json, GET /fallback/<name>, GET /health */
  handle = (req: http.IncomingMessage, res: http.ServerResponse): void => { // @spec VOICE-HTTP-002, VOICE-HTTP-003, VOICE-HTTP-004, VOICE-CLIP-008, VOICE-CLIP-011, VOICE-CLIP-012
    if (req.method !== "GET" && req.method !== "HEAD") { // @spec VOICE-HTTP-006
      res.writeHead(405, { allow: "GET, HEAD" }); res.end(); return;
    }
    const path = pathOf(req.url); // @spec VOICE-HTTP-007
    const m = /^\/audio\/([\w-]+)\.wav$/.exec(path);
    if (m) {
      const wav = this.store.get(m[1]!);
      if (!wav) { res.writeHead(404); res.end("gone"); return; }
      res.writeHead(200, { "content-type": "audio/wav", "content-length": wav.length, "access-control-allow-origin": "*" });
      res.end(wav);
      return;
    }
    const clips = this.d.clips;
    if (clips && path === "/fallback/manifest.json") {
      const manifest = clips.manifest();
      if (!manifest) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(manifest));
      return;
    }
    const clip = clips ? /^\/fallback\/([\w][\w.-]*)$/.exec(path) : null;
    if (clips && clip) {
      void clips.clipBytes(clip[1]!).then((wav) => {
        if (!wav) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { "content-type": "audio/wav", "content-length": wav.length });
        res.end(wav);
      });
      return;
    }
    if (path === "/health") { res.writeHead(200); res.end("ok"); return; }
    res.writeHead(404); res.end();
  };
}
