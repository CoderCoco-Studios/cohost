/**
 * The dashboard's re-delivery of credentials (settings-store STORE-DLV-005): at its start, and afterwards while it runs, it
 * delivers to every running unit that waits for its credentials or whose container was started since its last delivery (a
 * Docker restart, a reboot), through the control plane's `ComposeProvisioner.redeliver`, whenever no lifecycle action holds
 * the lock.
 */
import type { Logger } from "@cohost/config";
import { WAITING_FOR_CREDENTIALS } from "@cohost/shared";

/** The delivery the control plane runs, given the units waiting and the units ready by their heartbeats. */
export type Redeliver = (o: { waiting: ReadonlySet<string>; ready: ReadonlySet<string> }) => Promise<{ delivered: string[]; failures: string[] }>;

export interface RedelivererDeps {
  redeliver: Redeliver;
  /** Claims the one action slot and the lifecycle lock (DASH-STACK-009); undefined while a lifecycle action holds them. */
  acquire: (kind: string) => (() => void) | undefined;
  log: Pick<Logger, "info" | "warn">;
  now?: () => number;
}

/**
 * Follows the heartbeats and runs the delivery when asked (at start, on a `waiting for credentials` heartbeat, on a change of
 * the stack probe). A unit counts as waiting only for a waiting heartbeat received after its last delivery, so one delivery
 * per container start is made; a run asked for while one is running runs once more after it; a run that finds a lifecycle
 * action holding the lock is skipped (that action delivers to what it starts).
 */
// @spec STORE-DLV-005
export class Redeliverer {
  private readonly beats = new Map<string, { state: string; detail?: string; at: number }>();
  private readonly delivered = new Map<string, number>();
  private running: Promise<void> | undefined;
  private again = false;
  /** False until `start`: no run is made before the heartbeat seed has been observed whole. */
  private live = false;
  private readonly now: () => number;

  constructor(private readonly d: RedelivererDeps) {
    this.now = d.now ?? Date.now;
  }

  /** Records a unit's heartbeat; a `waiting for credentials` one asks for a run. */
  observe(hb: { service: string; state: string; detail?: string }): void {
    this.beats.set(hb.service, { state: hb.state, ...(hb.detail !== undefined ? { detail: hb.detail } : {}), at: this.now() });
    if (this.live && hb.state === "starting" && hb.detail === WAITING_FOR_CREDENTIALS && this.waits(hb.service)) void this.run();
  }

  /**
   * Makes the first run, once the heartbeat seed has been observed, and lets every later trigger run: a run asked for before
   * (a seeded `waiting` heartbeat, a stack probe change) would miss the `ready` heartbeats seeded after it.
   */
  start(): Promise<void> {
    this.live = true;
    return this.run();
  }

  private waits(unit: string): boolean {
    const b = this.beats.get(unit);
    return b !== undefined && b.state === "starting" && b.detail === WAITING_FOR_CREDENTIALS && b.at > (this.delivered.get(unit) ?? -Infinity);
  }

  /** The units waiting and the units ready, by their newest heartbeats. */
  sets(): { waiting: Set<string>; ready: Set<string> } {
    const waiting = new Set<string>();
    const ready = new Set<string>();
    for (const [unit, b] of this.beats) {
      if (this.waits(unit)) waiting.add(unit);
      else if (b.state === "ready" || b.state === "degraded") ready.add(unit);
    }
    return { waiting, ready };
  }

  /** Runs the delivery once (or once more after the run in progress); resolves when it is done. */
  run(): Promise<void> {
    if (!this.live) return Promise.resolve();
    if (this.running) { this.again = true; return this.running; }
    this.running = (async () => {
      do {
        this.again = false;
        await this.once();
      } while (this.again);
    })().finally(() => { this.running = undefined; });
    return this.running;
  }

  private async once(): Promise<void> {
    const release = this.d.acquire("deliver");
    if (!release) return;
    try {
      const r = await this.d.redeliver(this.sets());
      const at = this.now();
      for (const u of r.delivered) {
        this.delivered.set(u, at);
        this.d.log.info(`delivered credentials to ${u}`);
      }
      for (const f of r.failures) this.d.log.warn(f);
    } catch (err) {
      this.d.log.warn({ err }, "the credentials could not be delivered");
    } finally {
      release();
    }
  }
}
