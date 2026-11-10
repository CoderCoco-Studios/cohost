import type { Logger } from "@cohost/config";
import {
  ONE_SHOTS, StackController, stackState,
  type ContainerStatus, type RuntimeResult, type ServiceController, type StackActionKind, type StackControllerOptions,
  type StackResult, type StackState, type StackStatus,
} from "@cohost/control";

export type BusState = "connected" | "unreachable";

export interface StackSnapshot {
  state: StackState;
  docker: { ok: boolean; detail?: string };
  bus: BusState;
  action: null | { kind: StackActionKind; phase: string; startedAt: number };
  last: null | { kind: StackActionKind; ok: boolean; detail?: string; services?: ContainerStatus[]; finishedAt: number };
  services: { service: string; status: string; health?: string }[];
}

/** The slice of `StackController` the service drives. */
export interface StackOps {
  status(): Promise<StackStatus>;
  launch(): Promise<StackResult>;
  stopAll(): Promise<StackResult>;
  restartAll(controller: Pick<ServiceController, "restart">): Promise<StackResult>;
  consolidate(): Promise<RuntimeResult>;
}

/** What `request` answers: started, or refused with the HTTP status the route sends. */
export type StackRequest = { ok: true; action: StackActionKind } | { ok: false; status: 409 | 503; detail: string };

/** Callbacks the stack controller reports through (DASH-STACK-007). */
export interface StackHooks {
  onPhase(kind: StackActionKind, phase: string): void;
  /** Takes a status the controller read itself (the launch readiness wait) as the current one. */
  observe(status: StackStatus): void;
  /** Runs `fn` after every earlier exclusive job, so two status probes never overlap. */
  exclusive<T>(fn: () => Promise<T>): Promise<T>;
}

export interface StackServiceOptions {
  log: Pick<Logger, "info" | "warn">;
  /** The feed's bus reachability (DASH-FEED-009). */
  bus: () => BusState;
  now?: () => number;
  probeMs?: number;
}

export const PROBE_MS = 5000;
const NOT_PROBED = "stack status has not been probed yet";

const isReady = (c: ContainerStatus): boolean => c.status === "running" && (c.health === undefined || c.health === "healthy");
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The dashboard's stack state: the latest Compose status probe, the one action slot, the last result.
 * It validates and starts stack actions (the routes only map its answer to HTTP), and tells listeners (the
 * `/ws` feed) whenever the snapshot changes.
 */
// @spec DASH-STACK-001, DASH-STACK-002, DASH-STACK-003, DASH-STACK-004, DASH-STACK-005, DASH-STACK-006, DASH-STACK-007
export class StackService {
  private ops?: StackOps;
  private status?: StackStatus;
  private slot?: string;
  private action: StackSnapshot["action"] = null;
  private last: StackSnapshot["last"] = null;
  private waiting = false;
  private probing = false;
  private chain: Promise<unknown> = Promise.resolve();
  private listeners = new Set<(s: StackSnapshot) => void>();
  private lastKey = "";
  private timer?: NodeJS.Timeout;
  private now: () => number;

  constructor(private o: StackServiceOptions) {
    this.now = o.now ?? Date.now;
  }

  attach(ops: StackOps): void { this.ops = ops; }

  readonly hooks: StackHooks = {
    onPhase: (kind, phase) => this.onPhase(kind, phase),
    observe: (s) => this.observe(s),
    exclusive: (fn) => {
      const run = this.chain.then(fn, fn);
      this.chain = run.catch(() => {});
      return run;
    },
  };

  // @spec DASH-STACK-001
  snapshot(): StackSnapshot {
    const st = this.status;
    const running = this.action?.kind === "launch" ? "launch" : this.action?.kind === "stop" ? "stop" : undefined;
    const docker = st ? st.docker : { ok: false, detail: NOT_PROBED };
    return {
      state: st ? stackState(st, running) : "docker-unavailable",
      docker,
      bus: this.o.bus(),
      action: this.action ? { ...this.action } : null,
      last: this.last ? { ...this.last } : null,
      services: (st?.services ?? [])
        .map((c) => ({ service: c.service, status: c.status, ...(c.health ? { health: c.health } : {}) }))
        .sort((a, b) => (a.service < b.service ? -1 : a.service > b.service ? 1 : 0)),
    };
  }

  // @spec DASH-FEED-008
  onChange(cb: (s: StackSnapshot) => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  /** Recomputes the snapshot and tells listeners when it differs from the last one told. */
  refresh(): void {
    const snap = this.snapshot();
    const key = JSON.stringify(snap);
    if (key === this.lastKey) return;
    this.lastKey = key;
    for (const cb of this.listeners) cb(snap);
  }

  private observe(s: StackStatus): void {
    this.status = s;
    this.refresh();
  }

  private onPhase(kind: StackActionKind, phase: string): void {
    if (!this.action || this.action.kind !== kind) return;
    this.action.phase = phase;
    if (kind === "launch" && phase === "waiting") this.waiting = true;
    this.refresh();
    if (!this.waiting) void this.probe();
  }

  /** One status probe; skipped while another is in flight or a launch's readiness wait supplies the statuses. */
  // @spec DASH-STACK-007
  async probe(): Promise<void> {
    if (!this.ops || this.probing || this.waiting) return;
    this.probing = true;
    try {
      this.observe(await this.ops.status());
    } catch (err) {
      this.observe({ docker: { ok: false, detail: message(err).slice(0, 500) }, services: [] });
    } finally {
      this.probing = false;
    }
  }

  /** Probes now and then every `probeMs` (default 5000) until `stop()`. */
  start(): void {
    void this.probe();
    this.timer = setInterval(() => void this.probe(), this.o.probeMs ?? PROBE_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Claims the one action slot for a per-service lifecycle request; the returned function frees it. Undefined when busy. */
  // @spec DASH-STACK-003
  tryAcquire(kind: string): (() => void) | undefined {
    if (this.slot) return undefined;
    this.slot = kind;
    return () => { if (this.slot === kind) this.slot = undefined; };
  }

  /** What holds the slot now (a stack action's kind or `service-<action>`), if anything. */
  busyKind(): string | undefined { return this.slot; }

  /** Validates a stack action (DASH-STACK-003 to 005) and, when allowed, starts it in the background. */
  // @spec DASH-STACK-002, DASH-STACK-003, DASH-STACK-004, DASH-STACK-005
  request(kind: StackActionKind, restarter: Pick<ServiceController, "restart">): StackRequest {
    if (this.slot) return { ok: false, status: 409, detail: `busy: ${this.slot}` };
    const st = this.status;
    if (!st || !st.docker.ok || !this.ops) return { ok: false, status: 503, detail: st?.docker.detail ?? NOT_PROBED };
    if (kind === "restart" && stackState(st) === "down") return { ok: false, status: 409, detail: "the stack is down: nothing to restart; launch it first" };
    if (kind === "consolidate" && st.services.some((c) => c.service === "memory" && c.status === "running")) {
      return { ok: false, status: 409, detail: "the memory service is running and consolidates on its own; stop the stack (or memory) first" };
    }
    this.slot = kind;
    this.action = { kind, phase: "starting", startedAt: this.now() };
    this.o.log.info({ kind }, `stack ${kind} started`);
    this.refresh();
    void this.run(kind, this.ops, restarter);
    return { ok: true, action: kind };
  }

  // @spec DASH-STACK-006
  private async run(kind: StackActionKind, ops: StackOps, restarter: Pick<ServiceController, "restart">): Promise<void> {
    let res: StackResult | RuntimeResult;
    try {
      res = kind === "launch" ? await ops.launch()
        : kind === "stop" ? await ops.stopAll()
        : kind === "restart" ? await ops.restartAll(restarter)
        : await ops.consolidate();
    } catch (err) {
      res = { ok: false, detail: message(err) };
    }
    const notReady = ((res as StackResult).services ?? [])
      .filter((c) => !ONE_SHOTS.includes(c.service) && !isReady(c))
      .map((c) => ({ service: c.service, status: c.status, ...(c.health ? { health: c.health } : {}) }));
    this.last = { kind, ok: res.ok, ...(res.detail ? { detail: res.detail } : {}), ...(notReady.length ? { services: notReady } : {}), finishedAt: this.now() };
    this.slot = undefined;
    this.action = null;
    this.waiting = false;
    if (res.ok) this.o.log.info({ kind, detail: res.detail }, `stack ${kind} finished`);
    else this.o.log.warn({ kind, detail: res.detail }, `stack ${kind} failed`);
    this.refresh();
    void this.probe();
  }
}

/** A `StackController` whose every status read (the launch readiness wait's included) is serialised and reported to the service. */
export class ObservedStackController extends StackController {
  constructor(options: StackControllerOptions, private hooks: Pick<StackHooks, "observe" | "exclusive">) {
    super(options);
  }

  override status(): Promise<StackStatus> {
    return this.hooks.exclusive(async () => {
      const s = await super.status();
      this.hooks.observe(s);
      return s;
    });
  }
}
