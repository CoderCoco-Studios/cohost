import { randomUUID } from "node:crypto";
import type { Bus } from "./index.js";
import {
  DEFAULT_CONNECTOR_INTERVAL_MS, REGISTRATION_VERSION, CONNECTOR_ID_PATTERN, findOffer, tagProblem,
  type ConnectorSpec, type Registration,
} from "./connector.js";

/**
 * Keeps one connector's registration alive: writes it at start, rewrites it every interval with a lease of three,
 * deletes it on orderly stop, refuses a tag another live connector serves, and yields to a newer instance.
 * One timer drives the registration and the optional heartbeat (CONN-REG-007).
 */
export class ConnectorRegistrar {
  readonly instance = randomUUID();
  readonly startedAt = Date.now();
  private timer: ReturnType<typeof setInterval> | undefined;
  private displaced = false;
  private stopped = false;
  private first = true;
  private busy = false;
  /** The registration last written. */
  last: Registration | undefined;

  /** @throws when the id or a capability's tag is invalid or reserved (CONN-TAG-001, CONN-TAG-002). */
  constructor(
    private readonly bus: Bus,
    private readonly spec: ConnectorSpec,
    private readonly onDisplaced?: () => void,
    private readonly onError?: (err: unknown) => void,
  ) {
    if (!CONNECTOR_ID_PATTERN.test(spec.id)) throw new Error(`connector id "${spec.id}" is invalid`);
    for (const c of spec.capabilities()) { const p = tagProblem(c.tag); if (p) throw new Error(p); }
  }

  get intervalMs(): number { return this.spec.intervalMs ?? DEFAULT_CONNECTOR_INTERVAL_MS; }

  /** Write the registration now and then every interval. */
  // @spec CONN-REG-002
  async start(): Promise<void> {
    await this.tick();
    if (this.stopped || this.displaced) return;
    this.timer = setInterval(() => { void this.tick().catch((e) => this.onError?.(e)); }, this.intervalMs);
    this.timer.unref?.();
  }

  /** One registration write (and heartbeat). Public so a test can drive the timer. */
  // @spec CONN-REG-001, CONN-REG-004, CONN-REG-007, CONN-TAG-003
  async tick(): Promise<void> {
    if (this.stopped || this.displaced || this.busy) return;
    this.busy = true;
    try {
      if (!this.first) {
        const mine = await this.bus.readRegistration(this.spec.id);
        if (mine && mine.instance !== this.instance) { this.displace(); return; }
      }
      const others = (await this.bus.listConnectors()).filter((r) => r.id !== this.spec.id);
      const conflicts: string[] = [];
      const capabilities = this.spec.capabilities().filter((c) => {
        const other = findOffer(others, c.cap, c.tag);
        if (!other) return true;
        conflicts.push(`${c.cap === "audio-in" ? "source" : "sink"} ${c.tag} is served by ${other.reg.id}`);
        return false;
      });
      const status = this.spec.status?.() ?? { state: "ready" };
      const reg: Registration = {
        v: REGISTRATION_VERSION, id: this.spec.id, kind: this.spec.kind, version: this.spec.version, instance: this.instance,
        pid: process.pid, startedAt: this.startedAt, intervalMs: this.intervalMs,
        state: conflicts.length ? "degraded" : status.state,
        detail: conflicts.length ? conflicts.join("; ") : (status.detail ?? ""),
        capabilities: capabilities.map((c) => ({ ...c, transport: c.transport ?? "stream" })),
      };
      this.last = reg;
      this.first = false;
      await this.bus.writeRegistration(reg);
      if (this.spec.heartbeat) await this.bus.publishHealth(this.spec.heartbeat(reg));
    } finally {
      this.busy = false;
    }
  }

  private displace(): void {
    this.displaced = true;
    if (this.timer) clearInterval(this.timer);
    this.onDisplaced?.();
  }

  /** Stop the timer and delete the registration if it is still this instance's (CONN-REG-003). */
  // @spec CONN-REG-003, CONN-REG-004
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.displaced) return;
    const mine = await this.bus.readRegistration(this.spec.id);
    if (!mine || mine.instance === this.instance) await this.bus.deleteRegistration(this.spec.id);
  }
}

/**
 * Re-read the registry every `intervalMs` and call `onChange` with the live registrations whenever they differ from the
 * last read, so a consumer notices a connector appearing or disappearing without a restart (CONN-REG-006).
 */
// @spec CONN-REG-006
export function watchConnectors(bus: Bus, onChange: (regs: Registration[]) => void, intervalMs = DEFAULT_CONNECTOR_INTERVAL_MS, onError?: (err: unknown) => void): { poll: () => Promise<void>; stop: () => void } {
  let prev = "";
  const poll = async (): Promise<void> => {
    try {
      const regs = (await bus.listConnectors()).sort((a, b) => a.id.localeCompare(b.id));
      const sig = JSON.stringify(regs.map((r) => [r.id, r.instance, r.state, r.capabilities.map((c) => [c.cap, c.tag, c.ready, c.transport])]));
      if (sig !== prev) { prev = sig; onChange(regs); }
    } catch (err) { onError?.(err); }
  };
  const timer = setInterval(() => { void poll(); }, intervalMs);
  timer.unref?.();
  void poll();
  return { poll, stop: () => clearInterval(timer) };
}
