import { type HeartbeatSpec } from "@cohost/shared";
import { classifyFailure, collect, type Synth, type TtsEngine } from "./engine.js";

/** While `tts` is down and the engine has a probe, the probe runs this often (VOICE-HLTH-007). */
export const PROBE_MS = 10_000;

/**
 * voice depends on its TTS server, named `tts` whichever engine serves it. `stub` has no dependency (`n/a`, mode `mock`).
 * An engine with a probe starts `down` until a probe succeeds; an incomplete configuration starts `down` with its reason;
 * any other engine starts `ok` and follows the outcome of its own synthesis (VOICE-HLTH-001 to VOICE-HLTH-010).
 */
export class VoiceHealth {
  private tts: "ok" | "down";
  private probe: TtsEngine | undefined;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private abort = new AbortController();
  readonly spec: HeartbeatSpec;

  constructor(private engine: TtsEngine) { // @spec VOICE-HLTH-001, VOICE-HLTH-003, VOICE-HLTH-009, VOICE-EGR-002
    this.tts = engine.configError || engine.ping ? "down" : "ok";
    const label = engine.destination ? `${engine.name} ${engine.destination}` : engine.name;
    this.spec = engine.name === "stub"
      ? { service: "voice", mode: "mock", deps: () => ({ tts: "n/a" }), detail: label }
      : {
        service: "voice", mode: "live", deps: () => ({ tts: this.tts }), detail: label,
        // the reason an incomplete configuration gives, shown in the heartbeat while tts is down (VOICE-GAP-003)
        reason: () => (this.engine.configError && this.tts === "down" ? `${label}: ${this.engine.configError}` : undefined),
      };
  }

  /**
   * Start probing an engine that has a `ping`: once at start, then every 10 s while `tts` is down. A successful probe
   * sets `tts` ok. Engines without a probe are a no-op.
   */
  startProbe(engine: TtsEngine): void { // @spec VOICE-HLTH-007, VOICE-HLTH-008
    if (!engine.ping) return;
    this.probe = engine;
    void this.probeOnce();
  }

  /** Stop the probe and abort a probe in flight. */
  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.abort.abort();
  }

  private async probeOnce(): Promise<void> {
    this.timer = undefined;
    const engine = this.probe;
    if (this.stopped || !engine?.ping) return;
    let ok = false;
    try { ok = await engine.ping(this.abort.signal); } catch { ok = false; } // a throwing probe is a failed one
    if (this.stopped) return;
    if (ok) this.tts = "ok";
    this.scheduleProbe();
  }

  private scheduleProbe(): void {
    if (this.stopped || !this.probe?.ping || this.timer || this.tts === "ok") return;
    this.timer = setTimeout(() => void this.probeOnce(), PROBE_MS);
  }

  private set(ok: boolean): void {
    this.tts = ok ? "ok" : "down";
    if (!ok) this.scheduleProbe();
  }

  /**
   * Wrap an engine as the synthesis function voice and the clip service call. Its outcome drives `deps.tts`: an
   * outage-class failure sets it down and a success sets it ok; a line-specific failure, zero frames and a stopped line
   * move nothing (VOICE-HLTH-002, VOICE-HLTH-006, VOICE-ERR-003).
   */
  track(engine: TtsEngine): Synth { // @spec VOICE-HLTH-002, VOICE-HLTH-006, VOICE-ERR-003
    return async (text, o) => {
      const discarded = o?.discarded;
      try {
        const wav = await collect(await engine.synthesize(text, {
          signal: o?.signal ?? new AbortController().signal,
          ...(o?.priority ? { priority: o.priority } : {}),
          ...(discarded ? { discarded } : {}),
        }));
        if (!discarded?.()) this.set(true);
        return wav;
      } catch (err) {
        if (!discarded?.() && classifyFailure(err) === "outage") this.set(false);
        throw err;
      }
    };
  }
}
