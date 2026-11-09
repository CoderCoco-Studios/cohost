import type { Config, Logger } from "@cohost/config";
import type { MemoryBackend } from "./store.js";
import { META_SHUTDOWN_RUN_OWED, type PassResult } from "./consolidation.js";

export type CortexState = "idle" | "thinking" | "speaking" | "muted";

export interface SchedulerDeps {
  store: Pick<MemoryBackend, "dirtyNoteCount" | "getMeta" | "setMeta">;
  /** Runs one consolidation pass; `gate` and `signal` are the scheduler's pacing and stop controls. */
  runPass(opts: { gate: () => Promise<void>; signal: AbortSignal }): Promise<PassResult>;
  cfg: Config["brain"]["memory"]["notes"];
  log: Logger;
}

/**
 * Decides when the memory service runs a consolidation pass: when enough notes are dirty, at startup when notes were left
 * dirty, and once more after a graceful stop. A pass waits for the cortex to be idle and pauses between viewers while it is not.
 */
export class ConsolidationScheduler {
  /** The cortex's latest `brain.status`, or undefined while none has arrived since start. */
  private cortex: CortexState | undefined;
  private scheduled = false;
  private running: Promise<void> | undefined;
  private readonly abort = new AbortController();
  private waiters: (() => void)[] = [];

  constructor(private readonly deps: SchedulerDeps) {}

  private get idle(): boolean {
    return this.cortex === undefined || this.cortex === "idle" || this.cortex === "muted";
  }

  // @spec MEM-CONSOL-002, MEM-CONSOL-003
  /** The cortex's state, from `brain.status`. */
  onBrainStatus(state: CortexState): void {
    this.cortex = state;
    if (!this.idle) return;
    const waiting = this.waiters;
    this.waiters = [];
    for (const wake of waiting) wake();
    this.start();
  }

  // @spec MEM-CONSOL-001
  /** Call after notes become dirty: schedules a pass when the dirty count has reached `dirty_threshold`. */
  async notifyDirty(): Promise<void> {
    if (this.scheduled || this.running || this.abort.signal.aborted) return;
    try {
      if ((await this.deps.store.dirtyNoteCount()) >= this.deps.cfg.dirty_threshold) this.schedule();
    } catch (err) {
      this.deps.log.warn({ err: String(err) }, "could not count dirty notes");
    }
  }

  // @spec MEM-CONSOL-013, MEM-CONSOL-015
  /** Call once the store is ready: catch up on notes a previous run left dirty. */
  async startup(): Promise<void> {
    const { store, cfg, log } = this.deps;
    try {
      const dirty = await store.dirtyNoteCount();
      const owed = (await store.getMeta(META_SHUTDOWN_RUN_OWED)) === "true";
      if (owed && dirty === 0) await store.setMeta(META_SHUTDOWN_RUN_OWED, "false"); // nothing was left to do
      if (dirty >= cfg.dirty_threshold || (owed && dirty > 0)) this.schedule();
    } catch (err) {
      log.warn({ err: String(err) }, "consolidation catch-up check failed");
    }
  }

  // @spec MEM-CONSOL-013
  /** On graceful shutdown: stop any pass (it keeps what it committed), then record that a run is owed. Call before closing the store. */
  async shutdown(graceMs = 1500): Promise<void> {
    this.abort.abort();
    this.scheduled = false;
    for (const wake of this.waiters.splice(0)) wake();
    if (this.running) {
      // The grace timer must keep the event loop alive: unref'd, a loop with nothing else pending would exit mid-shutdown.
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([this.running, new Promise<void>((r) => { timer = setTimeout(r, graceMs); })]);
      clearTimeout(timer);
    }
    try {
      await this.deps.store.setMeta(META_SHUTDOWN_RUN_OWED, "true");
    } catch (err) {
      this.deps.log.warn({ err: String(err) }, "could not record that a consolidation run is owed");
    }
  }

  private schedule(): void {
    if (this.scheduled || this.running || this.abort.signal.aborted) return;
    this.scheduled = true;
    this.start();
  }

  private start(): void {
    if (!this.scheduled || this.running || !this.idle) return;
    this.scheduled = false;
    this.running = this.deps
      .runPass({ gate: () => this.gate(), signal: this.abort.signal })
      .then(async (result) => {
        // A completed pass has processed every dirty note, so nothing is owed any more.
        if (result.status === "completed") await this.deps.store.setMeta(META_SHUTDOWN_RUN_OWED, "false");
      })
      .catch((err) => this.deps.log.warn({ err: String(err) }, "consolidation pass failed; the next pass will catch up"))
      .finally(() => { this.running = undefined; });
  }

  /** Resolves at once while the cortex is idle (or muted), otherwise when it next is. */
  private gate(): Promise<void> {
    return this.idle || this.abort.signal.aborted ? Promise.resolve() : new Promise<void>((resolve) => this.waiters.push(resolve));
  }
}
