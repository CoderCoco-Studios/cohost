/**
 * The speech-to-text router: the one place engine outcomes reach `deps.stt` (EARS-HLTH-*). Batch calls (whole clips,
 * live fallbacks, injections) and streaming sessions go through it, so the health rules sit beside the engine rules.
 */
import type { Logger } from "@cohost/config";
import { NO_BATCH_ENGINE, SttCapacityError, STT_PING_INTERVAL_MS, isOutage, withTimeout, type BatchSttEngine, type BuiltEngines, type SttSession, type StreamingSttEngine } from "./engines.js";
import type { EarsHealth } from "./health.js";

/** `ears.max_stt_sessions`: sessions open at once across every source (EARS-SES-008). */
export class SessionSlots {
  private used = 0;
  constructor(private readonly max: number) {}
  acquire(): boolean {
    if (this.used >= this.max) return false;
    this.used++;
    return true;
  }
  release(): void {
    if (this.used > 0) this.used--;
  }
}

export interface SttRouterDeps {
  built: BuiltEngines;
  health: EarsHealth;
  log: Pick<Logger, "info" | "warn">;
  /** `ears.stt_timeout_ms`. */
  timeoutMs: number;
  /** `ears.max_stt_sessions`. */
  maxSessions: number;
  /** The probe period (EARS-HLTH-008); tests shorten it. */
  pingIntervalMs?: number;
}

export class SttRouter {
  readonly slots: SessionSlots;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly d: SttRouterDeps) {
    this.slots = new SessionSlots(d.maxSessions);
  }

  /** The batch engine, when there is one. */
  get batch(): BatchSttEngine | undefined {
    return this.d.built.batch;
  }

  /** The streaming engine sessions open on; absent when the batch engine serves every utterance or the selected engine has a gap. */
  get stream(): StreamingSttEngine | undefined {
    const s = this.d.built.selected;
    return s.kind === "streaming" && this.d.built.selectedGap === undefined ? s : undefined;
  }

  /** Whether the selected engine streams (EARS-SES-001 and EARS-PART-004 choose by this). */
  get streamingSelected(): boolean {
    return this.d.built.selected.kind === "streaming";
  }

  // @spec EARS-HLTH-008
  /** Starts the readiness probe of a streaming engine that has one: a ping at once, then every period while `deps.stt` is down. */
  start(): void {
    const s = this.d.built.selected;
    if (s.kind !== "streaming" || !s.ping || this.d.built.selectedGap !== undefined) return;
    const probe = async (): Promise<void> => {
      if (!this.d.health.sttDown()) return;
      try {
        if (await s.ping!()) {
          this.d.log.info({ engine: s.name }, "speech-to-text engine ready");
          this.d.health.selectedOk();
        }
      } catch {
        // still down; the next probe tries again
      }
    };
    void probe();
    this.timer = setInterval(() => void probe(), this.d.pingIntervalMs ?? STT_PING_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  // @spec EARS-ENG-003, EARS-ENG-004, EARS-ENG-005, EARS-ENG-009, EARS-ENG-011, EARS-HLTH-004, EARS-HLTH-005, EARS-HLTH-007, EARS-HLTH-012
  /**
   * One batch call. `fallback` marks a live utterance the streaming engine could not serve (EARS-HLTH-005, 007); a whole clip
   * or an injection is not a fallback. Rejects with `no batch STT engine` when there is none (EARS-ENG-005).
   */
  async transcribe(audio: Buffer, o: { contentType?: string; fallback?: boolean } = {}): Promise<string> {
    const batch = this.d.built.batch;
    if (!batch) throw new Error(NO_BATCH_ENGINE);
    if (batch.gap !== undefined) throw new Error(batch.gap);
    const streaming = this.streamingSelected;
    try {
      const text = await batch.transcribe(audio, { contentType: o.contentType ?? "audio/wav" });
      if (!streaming) this.d.health.selectedOk();
      else if (o.fallback) this.d.health.fallbackOk();
      return text;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (isOutage(err)) {
        if (!streaming) this.d.health.selectedDown(reason);
        else this.d.health.fallbackFailed(reason);
        this.d.log.warn({ engine: batch.name, reason }, "batch transcription failed");
      }
      throw err;
    }
  }

  /** A batch request for a partial (EARS-PART-010): no health change, a failure only loses the partial. */
  partial(audio: Buffer): Promise<string> {
    const batch = this.d.built.batch;
    if (!batch) return Promise.reject(new Error(NO_BATCH_ENGINE));
    return batch.transcribe(audio);
  }

  // @spec EARS-SES-009, EARS-SES-010, EARS-HLTH-003, EARS-HLTH-011
  /** Opens a session bounded by `ears.stt_timeout_ms`; a capacity refusal leaves `deps.stt` alone, any other failure is an outage. */
  openSession(): Promise<SttSession> {
    const s = this.stream;
    if (!s) return Promise.reject(new Error(`${this.d.built.selected.name} has no session to open`));
    const p = s.open();
    return withTimeout(p, this.d.timeoutMs, `${s.name} session did not connect`).catch((err: unknown) => {
      // a connect that answers after the bound is ended at once
      p.then((late) => late.abort(), () => {});
      if (err instanceof SttCapacityError) {
        this.d.log.info({ engine: s.name }, "speech-to-text session refused: no free channel");
        throw err;
      }
      this.sessionFailed(err instanceof Error ? err.message : String(err));
      throw err;
    });
  }

  /** The final of a session, bounded by `ears.stt_timeout_ms` (EARS-SES-004). */
  finish(session: SttSession): Promise<string> {
    return withTimeout(session.finish(), this.d.timeoutMs, "session final did not arrive");
  }

  /** A session failed before its final, or did not deliver one (EARS-HLTH-003). */
  sessionFailed(reason: string): void {
    this.d.health.selectedDown(reason);
    this.d.log.warn({ engine: this.d.built.selected.name, reason }, "speech-to-text session failed");
  }

  /** A session delivered its final (EARS-HLTH-011). */
  sessionFinal(): void {
    this.d.health.selectedOk();
  }
}
