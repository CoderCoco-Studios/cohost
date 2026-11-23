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
  /** A probe is in flight: the next tick waits for it instead of piling another up. */
  private probing = false;

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
      if (this.probing || !this.d.health.sttDown()) return;
      // the slot is held until the ping itself settles, so a ping that never answers is not joined by another
      this.probing = true;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), this.d.timeoutMs);
      const pending = Promise.resolve().then(() => s.ping!(ac.signal));
      const settle = (): void => { this.probing = false; };
      pending.then(settle, settle);
      try {
        if (await withTimeout(pending, this.d.timeoutMs, `${s.name} ping did not answer`)) {
          this.d.log.info({ engine: s.name }, "speech-to-text engine ready");
          this.d.health.selectedOk();
        }
      } catch {
        // still down; the next probe tries again
      } finally {
        clearTimeout(timer);
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
      // the same rule for a whole clip and a fallback: a success clears a stale fallback failure (EARS-HLTH-007)
      if (!streaming) this.d.health.selectedOk();
      else this.d.health.fallbackOk();
      return text;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (isOutage(err)) {
        if (!streaming) this.d.health.selectedDown(reason);
        else this.d.health.fallbackFailed(reason);
        this.d.log.warn({ engine: batch.name, reason, fallback: o.fallback === true }, "batch transcription failed");
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
  /**
   * Opens a session. The connect is aborted at `ears.stt_timeout_ms` and when `caller` aborts (a source stop); a connect
   * that answers after either is ended at once. A capacity refusal leaves `deps.stt` alone (EARS-HLTH-004); a caller's
   * abort is not an outage; any other failure is.
   */
  openSession(caller?: AbortSignal): Promise<SttSession> {
    const s = this.stream;
    if (!s) return Promise.reject(new Error(`${this.d.built.selected.name} has no session to open`));
    const ms = this.d.timeoutMs;
    const ac = new AbortController();
    const onCaller = (): void => ac.abort(new Error("session cancelled"));
    if (caller?.aborted) onCaller();
    caller?.addEventListener("abort", onCaller, { once: true });
    const timer = setTimeout(() => ac.abort(new Error(`${s.name} session did not connect after ${ms} ms`)), ms);
    const cleanup = (): void => { clearTimeout(timer); caller?.removeEventListener("abort", onCaller); };
    // a synchronous throw of open() becomes a rejection, so the caller releases its slot
    const p = Promise.resolve().then(() => s.open({ signal: ac.signal }));
    const bound = new Promise<never>((_, reject) => {
      ac.signal.addEventListener("abort", () => reject(ac.signal.reason), { once: true });
    });
    return Promise.race([p, bound]).then(
      (session) => { cleanup(); return session; },
      (err: unknown) => {
        cleanup();
        // a connect that answers after the bound is ended at once
        p.then((late) => late.abort(), () => {});
        if (caller?.aborted) throw err;
        if (err instanceof SttCapacityError) {
          this.d.log.info({ engine: s.name }, "speech-to-text session refused: no free channel");
          throw err;
        }
        this.sessionFailed(err instanceof Error ? err.message : String(err));
        throw err;
      },
    );
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
