import type { Logger } from "@cohost/config";
import {
  BuildProgress, ONE_SHOTS, StackController, containerService, stackState,
  type ContainerStatus, type RuntimeResult, type ServiceController, type StackActionKind, type StackControllerOptions,
  type LockResult, type StackResult, type StackState, type StackStatus,
} from "@cohost/control";

export type BusState = "connected" | "unreachable";

export interface StackSnapshot {
  state: StackState;
  docker: { ok: boolean; detail?: string };
  bus: BusState;
  action: null | { kind: StackActionKind; phase: string; startedAt: number };
  last: null | { kind: StackActionKind; ok: boolean; detail?: string; services?: ContainerStatus[]; finishedAt: number };
  /**
   * Per container; `overrides` (CTRL-STACK-016) is empty for a container that sets none and absent where the probe could not read it;
   * `stale` marks, while a launch builds, a previous run's container Compose has not yet acted on (DASH-STACK-014).
   */
  services: { service: string; status: string; health?: string; restartCount?: number; overrides?: Record<string, string>; stale?: true }[];
}

export type ProgressRowState = "building" | "cached" | "built" | "failed" | "restarting" | "done";

/** One service of the Launch panel: a build (launch, rebuild) or a unit restart (restart-all). */
export interface ProgressRow {
  service: string;
  state: ProgressRowState;
  step?: number;
  of?: number;
  total?: number;
  done?: number;
  cached?: number;
  current?: string;
  detail?: string;
}

/** The progress record of the last launch, rebuild or restart-all (DASH-STACK-011), sent as `stack-progress` (DASH-FEED-013). */
export interface StackProgress {
  kind: StackActionKind;
  startedAt: number;
  running: boolean;
  ok?: boolean;
  finishedAt?: number;
  rows: ProgressRow[];
  lines: string[];
  failure?: { service?: string; lines: string[] };
}

/** The kinds that keep a progress record. */
const RECORDED: ReadonlySet<StackActionKind> = new Set(["launch", "rebuild", "restart"]);
export const PROGRESS_LINES = 200;
export const PROGRESS_MS = 250;
const FAILURE_LINES = 10;

interface ProgressState {
  kind: StackActionKind;
  startedAt: number;
  running: boolean;
  ok?: boolean;
  finishedAt?: number;
  lines: string[];
  parser?: BuildProgress;
  restarts: ProgressRow[];
  failure?: { service?: string; lines: string[] };
}

/** The slice of `StackController` the service drives. */
export interface StackOps {
  status(): Promise<StackStatus>;
  /** `status` with Compose restart counts; a probe uses it when present. */
  statusWithRestarts?(): Promise<StackStatus>;
  launch(): Promise<StackResult>;
  rebuild(): Promise<StackResult>;
  stopAll(): Promise<StackResult>;
  restartAll(controller: Pick<ServiceController, "restart">): Promise<StackResult>;
  consolidate(): Promise<RuntimeResult>;
}

/** What `request` answers: started, or refused with the HTTP status the route sends. */
export type StackRequest = { ok: true; action: StackActionKind } | { ok: false; status: 409 | 503; detail: string };

/** Callbacks the stack controller reports through (DASH-STACK-007). */
export interface StackHooks {
  onPhase(kind: StackActionKind, phase: string): void;
  /** One output line of a launch's or rebuild's `docker compose up` (control-plane CTRL-STACK-020). */
  onOutput(kind: StackActionKind, line: string): void;
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
  /** The control plane's lifecycle lock, shared with cohostctl (DASH-STACK-009); absent means no cross-process lock. */
  lock?: { tryAcquire(action: string): LockResult };
  /** This process's pid, named as the holder in an in-process busy refusal; `process.pid` by default. */
  pid?: number;
  /** The least time between two `stack-progress` pushes (default 250 ms); 0 pushes every change. */
  progressMs?: number;
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
// @spec DASH-STACK-001, DASH-STACK-002, DASH-STACK-003, DASH-STACK-004, DASH-STACK-005, DASH-STACK-006, DASH-STACK-007, DASH-STACK-009
export class StackService {
  private ops?: StackOps;
  private status?: StackStatus;
  private slot?: string;
  private unlock?: () => void;
  private foreign?: string;
  private action: StackSnapshot["action"] = null;
  private last: StackSnapshot["last"] = null;
  private waiting = false;
  private probing = false;
  private chain: Promise<unknown> = Promise.resolve();
  private listeners = new Set<(s: StackSnapshot) => void>();
  private lastKey = "";
  private timer?: NodeJS.Timeout;
  private now: () => number;
  private record?: ProgressState;
  private progressListeners = new Set<(p: StackProgress) => void>();
  private progressTimer?: NodeJS.Timeout;
  private progressDirty = false;
  /** The last restart count of each container, by container id, for the containers of the latest status (DASH-STACK-016). */
  private counts = new Map<string, number>();

  constructor(private o: StackServiceOptions) {
    this.now = o.now ?? Date.now;
  }

  attach(ops: StackOps): void { this.ops = ops; }

  readonly hooks: StackHooks = {
    onPhase: (kind, phase) => this.onPhase(kind, phase),
    onOutput: (kind, line) => this.onOutput(kind, line),
    observe: (s) => this.observe(s),
    exclusive: (fn) => {
      const run = this.chain.then(fn, fn);
      this.chain = run.catch(() => {});
      return run;
    },
  };

  // @spec DASH-STACK-001, DASH-STACK-010
  snapshot(): StackSnapshot {
    const st = this.status;
    const running = this.action?.kind === "launch" || this.action?.kind === "rebuild" ? "launch" : this.action?.kind === "stop" ? "stop" : undefined;
    const docker = st ? st.docker : { ok: false, detail: NOT_PROBED };
    const stale = this.staleServices();
    return {
      state: st ? stackState(st, running) : "docker-unavailable",
      docker,
      bus: this.o.bus(),
      action: this.action ? { ...this.action } : null,
      last: this.last ? { ...this.last } : null,
      services: (st?.services ?? [])
        .map((c) => ({ service: c.service, status: c.status, ...(c.health ? { health: c.health } : {}), ...(c.restartCount !== undefined ? { restartCount: c.restartCount } : {}), ...(c.overrides ? { overrides: { ...c.overrides } } : {}), ...(stale?.(c) ? { stale: true as const } : {}) }))
        .toSorted((a, b) => (a.service < b.service ? -1 : a.service > b.service ? 1 : 0)),
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

  /**
   * While a launch or rebuild builds, the test for a previous run's container: not running, and its service named by no
   * Compose container line of this run (DASH-STACK-014). Undefined at any other time.
   */
  // @spec DASH-STACK-014
  private staleServices(): ((c: ContainerStatus) => boolean) | undefined {
    const a = this.action;
    const parser = this.record?.running ? this.record.parser : undefined;
    if (!a || (a.kind !== "launch" && a.kind !== "rebuild") || a.phase === "waiting" || !parser) return undefined;
    const names = (this.status?.services ?? []).map((c) => c.service);
    const touched = new Set(parser.touched().map((n) => containerService(n, names)));
    return (c) => c.status !== "running" && !touched.has(c.service);
  }

  /** Takes a status as current, keeping each container's restart count across reads that lack one (DASH-STACK-016). */
  // @spec DASH-STACK-016
  private observe(s: StackStatus): void {
    // Rebuilt from each status, so a container that is gone (recreated under a new id, or removed) leaves no count behind.
    const next = new Map<string, number>();
    const services = s.services.map((c) => {
      if (c.id === undefined) return c;
      const prior = this.counts.get(c.id);
      const count = c.restartCount === undefined ? prior : Math.max(c.restartCount, prior ?? 0);
      if (count === undefined) return c;
      next.set(c.id, count);
      return { ...c, restartCount: count };
    });
    this.counts = next;
    this.status = { ...s, services };
    this.refresh();
  }

  /** The progress record of the last launch, rebuild or restart-all, or null before the first (DASH-STACK-011). */
  // @spec DASH-STACK-011, DASH-STACK-013, DASH-STACK-017
  progress(): StackProgress | null {
    const r = this.record;
    if (!r) return null;
    const rows: ProgressRow[] = r.parser
      ? r.parser.rows().map((b) => ({ ...b, state: r.ok === true && b.state === "building" ? "built" : b.state }))
      : r.restarts.map((x) => ({ ...x }));
    return {
      kind: r.kind, startedAt: r.startedAt, running: r.running,
      ...(r.ok !== undefined ? { ok: r.ok } : {}), ...(r.finishedAt !== undefined ? { finishedAt: r.finishedAt } : {}),
      rows, lines: [...r.lines],
      ...(r.failure ? { failure: { ...r.failure, lines: [...r.failure.lines] } } : {}),
    };
  }

  /** Hears each change of the progress record, at most one per `progressMs`, and the end at once (DASH-FEED-013). */
  onProgress(cb: (p: StackProgress) => void): () => void {
    this.progressListeners.add(cb);
    return () => { this.progressListeners.delete(cb); };
  }

  private emitProgress(): void {
    this.progressDirty = false;
    const p = this.progress();
    if (p) for (const cb of this.progressListeners) cb(p);
  }

  /** Leading and trailing throttle: a change with no push in the window goes at once; later ones wait for the window's end. */
  // @spec DASH-FEED-013
  private progressChanged(flush = false): void {
    const ms = this.o.progressMs ?? PROGRESS_MS;
    if (ms <= 0) {
      this.emitProgress();
      return;
    }
    if (flush) {
      if (this.progressTimer) clearTimeout(this.progressTimer);
      this.progressTimer = undefined;
      this.emitProgress();
      // A record that has just started opens a window, so the output that follows at once waits for its end.
      if (this.record?.running) this.openWindow(ms);
      return;
    }
    if (this.progressTimer) {
      this.progressDirty = true;
      return;
    }
    this.emitProgress();
    this.openWindow(ms);
  }

  /** Starts a throttle window; at its end the latest record goes out when it changed meanwhile, and the next window opens. */
  private openWindow(ms: number): void {
    const window = () => {
      this.progressTimer = undefined;
      if (!this.progressDirty) return;
      this.emitProgress();
      this.openWindow(ms);
    };
    this.progressTimer = setTimeout(window, ms);
    this.progressTimer.unref?.();
  }

  private appendLine(r: ProgressState, line: string): void {
    r.lines.push(line);
    if (r.lines.length > PROGRESS_LINES) r.lines.splice(0, r.lines.length - PROGRESS_LINES);
  }

  /** One `up` output line: into the ring, the parser and the log (DASH-STACK-011, DASH-STACK-012). */
  // @spec DASH-STACK-011, DASH-STACK-012
  private onOutput(kind: StackActionKind, line: string): void {
    const r = this.record;
    if (!r || !r.running || r.kind !== kind) return;
    this.appendLine(r, line);
    this.o.log.info(`${kind} | ${line}`);
    if (r.parser?.push(line)) this.refresh(); // a container line can end a container's stale mark
    this.progressChanged();
  }

  private onPhase(kind: StackActionKind, phase: string): void {
    if (!this.action || this.action.kind !== kind) return;
    this.action.phase = phase;
    const r = this.record;
    if (kind === "restart" && r?.running && r.kind === "restart" && phase.startsWith("restarting ")) { // DASH-STACK-013
      const id = phase.slice("restarting ".length);
      for (const row of r.restarts) if (row.state === "restarting") row.state = "done";
      r.restarts.push({ service: id, state: "restarting" });
      this.appendLine(r, phase);
      this.progressChanged();
    }
    if ((kind === "launch" || kind === "rebuild") && phase === "waiting") this.waiting = true;
    this.refresh();
    if (!this.waiting) void this.probe();
  }

  /** One status probe; skipped while another is in flight or a launch's readiness wait supplies the statuses. */
  // @spec DASH-STACK-007
  async probe(): Promise<void> {
    if (!this.ops || this.probing || this.waiting) return;
    this.probing = true;
    try {
      this.observe(await (this.ops.statusWithRestarts ? this.ops.statusWithRestarts() : this.ops.status()));
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
  // @spec DASH-STACK-003, DASH-STACK-009
  tryAcquire(kind: string): (() => void) | undefined {
    if (this.slot) return undefined;
    const held = this.takeLock(kind);
    if (!held.ok) return undefined;
    this.slot = kind;
    return () => { if (this.slot === kind) { this.slot = undefined; held.release(); } };
  }

  /** What holds the slot now (a stack action's kind or `service-<action>`), if anything. */
  busyKind(): string | undefined { return this.slot; }

  /** The `detail` of a refused claim: the in-process holder, else the other process holding the lock. */
  busyDetail(): string { return this.slot ? this.inProcessDetail(this.slot) : this.foreign ?? "busy"; }

  /** The lock's refusal text (CTRL-LOCK-002) for the action this process is running. */
  private inProcessDetail(kind: string): string { return `busy: ${kind} held by dashboard (pid ${this.o.pid ?? process.pid})`; }

  /** Takes the cross-process lock; a refusal is remembered as the `busy` detail. */
  private takeLock(kind: string): LockResult {
    this.foreign = undefined;
    const r = this.o.lock?.tryAcquire(kind) ?? { ok: true as const, release: () => {} };
    if (!r.ok) this.foreign = r.detail;
    return r;
  }

  /** Validates a stack action (DASH-STACK-003 to 005) and, when allowed, starts it in the background. */
  // @spec DASH-STACK-002, DASH-STACK-003, DASH-STACK-004, DASH-STACK-005, DASH-STACK-009
  request(kind: StackActionKind, restarter: Pick<ServiceController, "restart">): StackRequest {
    if (this.slot) return { ok: false, status: 409, detail: this.inProcessDetail(this.slot) };
    const st = this.status;
    if (!st || !st.docker.ok || !this.ops) return { ok: false, status: 503, detail: st?.docker.detail ?? NOT_PROBED };
    if (kind === "restart" && stackState(st) === "down") return { ok: false, status: 409, detail: "the stack is down: nothing to restart; launch it first" };
    if (kind === "consolidate" && st.services.some((c) => c.service === "memory" && c.status === "running")) {
      return { ok: false, status: 409, detail: "the memory service is running and consolidates on its own; stop the stack (or memory) first" };
    }
    const held = this.takeLock(kind);
    if (!held.ok) return { ok: false, status: 409, detail: held.detail };
    this.slot = kind;
    this.unlock = held.release;
    this.action = { kind, phase: "starting", startedAt: this.now() };
    if (RECORDED.has(kind)) {
      this.record = { kind, startedAt: this.action.startedAt, running: true, lines: [], restarts: [], ...(kind === "restart" ? {} : { parser: new BuildProgress() }) };
      this.progressChanged(true);
    }
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
        : kind === "rebuild" ? await ops.rebuild()
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
    const r = this.record;
    if (r?.running && r.kind === kind) this.finishRecord(r, res);
    this.slot = undefined;
    this.unlock?.();
    this.unlock = undefined;
    this.action = null;
    this.waiting = false;
    if (res.ok) this.o.log.info({ kind, detail: res.detail }, `stack ${kind} finished`);
    else this.o.log.warn({ kind, detail: res.detail }, `stack ${kind} failed`);
    this.refresh();
    if (r?.kind === kind) this.progressChanged(true);
    void this.probe();
  }

  /** Ends the record: its outcome, a restart-all's per-unit rows, and the failure (DASH-STACK-013, DASH-STACK-017). */
  // @spec DASH-STACK-013, DASH-STACK-017
  private finishRecord(r: ProgressState, res: StackResult | RuntimeResult): void {
    r.running = false;
    r.ok = res.ok;
    r.finishedAt = this.now();
    if (r.kind === "restart") {
      for (const o of (res as StackResult).restarts ?? []) {
        let row = r.restarts.find((x) => x.service === o.id);
        if (!row) {
          row = { service: o.id, state: "restarting" };
          r.restarts.push(row);
        }
        row.state = o.ok ? "done" : "failed";
        if (!o.ok) row.detail = o.detail ?? "failed";
        this.appendLine(r, o.ok ? `${o.id} restarted` : `${o.id} failed: ${o.detail ?? "failed"}`);
      }
      const failed = r.restarts.find((x) => x.state === "failed");
      if (failed) r.failure = { service: failed.service, lines: [failed.detail ?? "failed"] };
      else if (!res.ok) r.failure = { lines: [res.detail ?? "failed"] };
      return;
    }
    if (res.ok) return;
    const parsed = r.parser?.failure();
    r.failure = parsed ?? (r.lines.length ? { lines: r.lines.slice(-FAILURE_LINES) } : { lines: [res.detail ?? "failed"] });
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

  /** Serialised like `status`, but observed only by its caller: the plain read inside it never reaches the snapshot (DASH-STACK-015). */
  // @spec DASH-STACK-015
  override statusWithRestarts(): Promise<StackStatus> {
    return this.hooks.exclusive(() => super.statusWithRestarts());
  }
}
