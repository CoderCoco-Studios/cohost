import type { Logger } from "@cohost/config";
import { beforeShutdown } from "./index.js";
import type { EventInput } from "./events.js";

type HeartbeatInput = EventInput<"service.heartbeat">;
type DepStatus = HeartbeatInput["deps"][string];

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
  intervalMs?: number;
  log?: Logger;
}

/** The service-specific part of the options; what each service's health.ts exports. */
export type HeartbeatSpec = Pick<HeartbeatOptions, "service" | "mode" | "deps">;

/**
 * Wrap an async call so its outcome feeds a dependency status:
 * `set(true)` after a success, `set(false)` after a failure (the error still propagates).
 */
export function tracked<A extends unknown[], R>(fn: (...a: A) => Promise<R>, set: (ok: boolean) => void): (...a: A) => Promise<R> {
  return async (...a) => {
    try { const r = await fn(...a); set(true); return r; }
    catch (err) { set(false); throw err; }
  };
}

export interface Heartbeat {
  ready(): void;
  degraded(detail?: string): void;
  /** Publish one `stopping` heartbeat and cancel the timer. Idempotent. */
  stop(): Promise<void>;
}

const processStartedAt = Date.now();

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
export function startHeartbeat(bus: HealthPublisher, opts: HeartbeatOptions): Heartbeat {
  const intervalMs = opts.intervalMs ?? heartbeatIntervalMs();
  let base: "starting" | "ready" | "degraded" = "starting";
  let detail: string | undefined;
  let stopped = false;
  let lastKey = "";

  const snapshot = (): HeartbeatInput => {
    const deps = typeof opts.deps === "function" ? opts.deps() : opts.deps;
    const down = Object.entries(deps).filter(([, v]) => v === "down").map(([k]) => k);
    const state = base === "ready" && down.length ? "degraded" : base;
    const d = detail ?? (state === "degraded" && base === "ready" ? `dependency down: ${down.join(", ")}` : undefined);
    return {
      service: opts.service,
      instance: bus.consumer,
      pid: process.pid,
      version: opts.version ?? process.env.COHOST_VERSION ?? "dev",
      startedAt: processStartedAt,
      state,
      deps,
      mode: typeof opts.mode === "function" ? opts.mode() : opts.mode,
      ...(d ? { detail: d } : {}),
      intervalMs,
    };
  };

  const send = async (hb: HeartbeatInput): Promise<void> => {
    try { await bus.publishHealth(hb); }
    catch (err) { opts.log?.warn({ err, service: opts.service }, "heartbeat publish failed"); }
  };

  const emit = (): Promise<void> => {
    const hb = snapshot();
    lastKey = JSON.stringify([hb.state, hb.deps, hb.mode, hb.detail]);
    return send(hb);
  };

  const check = () => {
    if (stopped) return;
    const hb = snapshot();
    const key = JSON.stringify([hb.state, hb.deps, hb.mode, hb.detail]);
    if (key !== lastKey) void emit();
  };

  void emit();
  // One timer for the steady beat, one (at most 1 s) to notice dep/mode changes.
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
    stop,
  };
}
