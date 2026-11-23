/**
 * Process lifecycle: the per-process shutdown sequence and the heartbeat publisher. Moved here from
 * `@cohost/bus` (which keeps only the transport) so the bus no longer imports its own heartbeat module.
 */
import type { Logger } from "@cohost/config";
import type { EventInput } from "@cohost/bus";

type HeartbeatInput = EventInput<"service.heartbeat">;
type DepStatus = HeartbeatInput["deps"][string];

// ---- shutdown

const shutdownHooks: (() => void | Promise<void>)[] = [];
/** Max time pre-shutdown hooks (e.g. the `stopping` heartbeat) may delay exit. */
const HOOK_TIMEOUT_MS = 2000;

/** Register work that must finish before the service's own onShutdown callback runs. */
export function beforeShutdown(fn: () => void | Promise<void>): void {
  shutdownHooks.push(fn);
}

type ShutdownLog = Pick<Logger, "error">;
const shutdownCallbacks: { fn: () => void | Promise<void>; log?: ShutdownLog }[] = [];
let shutdownInstalled = false;
let shutdownStarted = false;

/** The process-wide shutdown sequence: hooks (<= 2 s), then every callback in order, then exit(0) once. */
async function runShutdown(): Promise<void> {
  if (shutdownStarted) return;
  shutdownStarted = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      // `async` turns a synchronous throw from a hook into a rejection, which allSettled absorbs.
      Promise.allSettled(shutdownHooks.map(async (h) => h())),
      new Promise((r) => { timer = setTimeout(r, HOOK_TIMEOUT_MS); timer.unref(); }),
    ]);
    for (const { fn, log } of shutdownCallbacks) {
      try {
        await fn();
      } catch (err) {
        if (log) log.error({ err }, "shutdown callback failed");
        else console.error("shutdown callback failed", err);
      }
    }
  } finally { clearTimeout(timer); process.exit(0); }
}

/**
 * Shared graceful-shutdown helper for services. Every registration joins one per-process sequence
 * (the signal handlers are installed once); `log` is optional and falls back to `console.error`.
 */
// @spec SHARED-LIFE-001, SHARED-LIFE-002, SHARED-LIFE-003, SHARED-LIFE-004, SHARED-LIFE-005
export function onShutdown(fn: () => void | Promise<void>, log?: ShutdownLog): void {
  shutdownCallbacks.push({ fn, log });
  if (shutdownInstalled) return;
  shutdownInstalled = true;
  process.on("SIGINT", () => { void runShutdown(); });
  process.on("SIGTERM", () => { void runShutdown(); });
}

// ---- heartbeat

/** What startHeartbeat needs from a Bus (so tests can pass a fake). */
export interface HealthPublisher {
  readonly consumer: string;
  publishHealth(data: HeartbeatInput): Promise<string>;
}

export interface HeartbeatOptions {
  service: string;
  version?: string;
  /** "live" | "mock" | "off". May be a getter if it can change at runtime. */
  mode: string | (() => string);
  /** Dependency status, re-read every check so changes publish immediately. */
  deps: Record<string, DepStatus> | (() => Record<string, DepStatus>);
  /** Standing note shown while no explicit `degraded(detail)` or dependency-down detail applies. */
  detail?: string;
  intervalMs?: number;
  log?: Logger;
  /** Monotonic millisecond clock for the publish-failure warning rate limit (default `performance.now`). */
  now?: () => number;
}

/** The service-specific part of the options; what each service's health.ts exports. */
export type HeartbeatSpec = Pick<HeartbeatOptions, "service" | "mode" | "deps" | "detail">;

/**
 * Wrap an async call so its outcome feeds a dependency status:
 * `set(true)` after a success, `set(false)` after a failure (the error still propagates).
 */
// @spec SHARED-LIFE-012
export function tracked<A extends unknown[], R>(fn: (...a: A) => Promise<R>, set: (ok: boolean) => void): (...a: A) => Promise<R> {
  return async (...a) => {
    try { const r = await fn(...a); set(true); return r; }
    catch (err) { set(false); throw err; }
  };
}

export interface Heartbeat {
  ready(): void;
  degraded(detail?: string): void;
  /** Replace the standing detail (SHARED-LIFE-014); `undefined` clears it. */
  setDetail(detail: string | undefined): void;
  /** Override the reported mode (the idle plan sets `off`); `undefined` returns to the options' mode. */
  setMode(mode: string | undefined): void;
  /** Publish one `stopping` heartbeat and cancel the timer. Idempotent. */
  stop(): Promise<void>;
}

const processStartedAt = Date.now();
/** At most one failed-publish warning per heartbeat in this window. */
const FAIL_WARN_EVERY_MS = 60_000;

export function heartbeatIntervalMs(): number {
  const n = Number(process.env.HEARTBEAT_INTERVAL_MS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 5000;
}

/**
 * Publish this service's liveness/readiness to `cohost:health`: `starting`
 * now, then every intervalMs, immediately on ready()/degraded() and whenever
 * deps/mode change (checked at least once a second), and `stopping` on
 * shutdown (before the service's own onShutdown callback runs).
 */
// @spec SHARED-LIFE-006, SHARED-LIFE-007, SHARED-LIFE-008, SHARED-LIFE-009, SHARED-LIFE-010, SHARED-LIFE-011, SHARED-LIFE-013, SHARED-LIFE-014
export function startHeartbeat(bus: HealthPublisher, opts: HeartbeatOptions): Heartbeat {
  const intervalMs = opts.intervalMs ?? heartbeatIntervalMs();
  const clock = opts.now ?? (() => performance.now());
  let base: "starting" | "ready" | "degraded" = "starting";
  let detail: string | undefined;
  let standing = opts.detail;
  let modeOverride: string | undefined;
  let stopped = false;
  let lastKey = "";
  let lastWarnAt = -Infinity;
  let failedSince = 0;

  const snapshot = (): HeartbeatInput => {
    const deps = typeof opts.deps === "function" ? opts.deps() : opts.deps;
    const down = Object.entries(deps).filter(([, v]) => v === "down").map(([k]) => k);
    const state = base === "ready" && down.length ? "degraded" : base;
    const d = detail ?? (state === "degraded" && base === "ready" ? `dependency down: ${down.join(", ")}` : undefined) ?? standing;
    return {
      service: opts.service,
      instance: bus.consumer,
      pid: process.pid,
      version: opts.version ?? process.env.COHOST_VERSION ?? "dev",
      startedAt: processStartedAt,
      state,
      deps,
      mode: modeOverride ?? (typeof opts.mode === "function" ? opts.mode() : opts.mode),
      ...(d ? { detail: d } : {}),
      intervalMs,
    };
  };

  const send = async (hb: HeartbeatInput): Promise<void> => {
    try { await bus.publishHealth(hb); }
    catch (err) {
      failedSince++;
      const t = clock();
      if (t - lastWarnAt >= FAIL_WARN_EVERY_MS) {
        lastWarnAt = t;
        opts.log?.warn({ err, service: opts.service, failed: failedSince }, "heartbeat publish failed");
        failedSince = 0;
      }
    }
  };

  const keyOf = (hb: HeartbeatInput) => JSON.stringify([hb.state, hb.deps, hb.mode, hb.detail]);
  const emit = (): Promise<void> => {
    const hb = snapshot();
    lastKey = keyOf(hb);
    return send(hb);
  };

  const check = () => {
    if (stopped) return;
    if (keyOf(snapshot()) !== lastKey) void emit();
  };

  void emit();
  // One timer for the steady beat, one (at most 1 s) to notice dep/mode/detail changes.
  const beat = setInterval(() => { if (!stopped) void emit(); }, intervalMs);
  const watch = setInterval(check, Math.min(1000, intervalMs));
  beat.unref(); watch.unref();

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    clearInterval(beat); clearInterval(watch);
    await send({ ...snapshot(), state: "stopping" });
  };
  beforeShutdown(stop);

  return {
    ready() { base = "ready"; detail = undefined; if (!stopped) void emit(); },
    degraded(d) { base = "degraded"; detail = d; if (!stopped) void emit(); },
    setDetail(d) { standing = d; },
    setMode(m) { modeOverride = m; },
    stop,
  };
}
