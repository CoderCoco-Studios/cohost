import type { EventData } from "@cohost/bus";
import { appServiceIds, SERVICE_MANIFEST, type ServiceDef } from "./manifest.js";
import type { StackStatus } from "./stack.js";

export type HeartbeatData = EventData<"service.heartbeat">;

export type HealthState = "up" | "degraded" | "stale" | "down" | "unknown" | "crash-looping";

export const STALE_FACTOR = 3;
export const DOWN_FACTOR = 10;
export const CRASH_LOOP_WINDOW_MS = 60_000;
export const CRASH_LOOP_RESTARTS = 3;

export interface ServiceHealth {
  service: string;
  state: HealthState;
  /** Latest heartbeat, if any has ever been seen. */
  heartbeat?: HeartbeatData;
  /** ms since the latest heartbeat was received (tracker clock). */
  lastSeenAgeMs?: number;
  /** Distinct `startedAt` values first seen within the last 60 s. */
  restarts: number;
  /** The container's Compose restart count, when a stack status supplied one (`withContainerRestarts`). */
  containerRestarts?: number;
  /**
   * Present on a unit that declares `uses`: each used unit whose derived state is `down`, `stale`, `crash-looping` or
   * `unknown` (empty when every one is fine). An annotation only: the unit's own `state` never changes because of it.
   */
  needs?: Need[];
}

export interface Need { service: string; state: HealthState }

const NEEDY_STATES: ReadonlySet<HealthState> = new Set<HealthState>(["down", "stale", "crash-looping", "unknown"]);

/**
 * Adds `needs` to each entry of a snapshot from the states in that same snapshot (a used unit absent from it counts as
 * `unknown`). Pure and idempotent, so a layer that changes states afterwards calls it again.
 */
// @spec MOD-LIFE-001
export function withNeeds(snapshot: ServiceHealth[], manifest: readonly ServiceDef[] = SERVICE_MANIFEST): ServiceHealth[] {
  const state = new Map(snapshot.map((s) => [s.service, s.state]));
  return snapshot.map((entry) => {
    const uses = manifest.find((u) => u.id === entry.service)?.uses ?? [];
    const { needs: _old, ...rest } = entry;
    if (uses.length === 0) return rest;
    const needs = uses.map((service) => ({ service, state: state.get(service) ?? ("unknown" as const) })).filter((n) => NEEDY_STATES.has(n.state));
    return { ...rest, needs };
  });
}

export interface HealthTrackerOptions {
  /** Monotonic clock in ms (default `performance.now()`); every age is measured on it. Injectable for tests. */
  now?: () => number;
  /** Wall clock in ms (default `Date.now`); read only to age seeded history, whose `ts` is a wall-clock stamp. */
  wall?: () => number;
  /** Service names always listed in snapshots (default `appServiceIds()`). */
  known?: readonly string[];
}

interface Entry {
  hb: HeartbeatData;
  receivedAt: number;
  /** First time each distinct startedAt was seen (receive clock). */
  starts: { startedAt: number; seenAt: number }[];
}

/**
 * Derives per-service health from heartbeats using its own monotonic receive-time clock
 * (so neither clock skew between containers nor a wall-clock step is relevant). Derived states
 * are never published. See docs/intent/control-plane/control-plane-specs.md.
 */
// @spec CTRL-HEALTH-008
export class HealthTracker {
  private entries = new Map<string, Entry>();
  private listeners = new Set<(snapshot: ServiceHealth[]) => void>();
  private lastKeys = new Map<string, string>();
  private readonly now: () => number;
  private readonly wall: () => number;
  private readonly known: readonly string[];

  constructor(opts: HealthTrackerOptions = {}) {
    this.now = opts.now ?? (() => performance.now());
    this.wall = opts.wall ?? Date.now;
    this.known = opts.known ?? appServiceIds();
  }

  /** Record a heartbeat. `at` (on the tracker's monotonic clock) defaults to now; `seed` passes a past time. */
  ingest(hb: HeartbeatData, at = this.now()): void {
    const prev = this.entries.get(hb.service);
    const starts = prev?.starts ?? [];
    if (!starts.some((s) => s.startedAt === hb.startedAt)) starts.push({ startedAt: hb.startedAt, seenAt: at });
    // Keep a bounded history: starts older than the window can never matter again.
    const cutoff = this.now() - CRASH_LOOP_WINDOW_MS;
    // An older replayed heartbeat must not overwrite a newer one.
    const newer = prev && prev.receivedAt > at ? prev.hb : hb;
    // The current process's start is kept even when old, so it is not re-counted as a restart.
    const kept = starts.filter((s) => s.seenAt >= cutoff || s.startedAt === newer.startedAt);
    this.entries.set(hb.service, { hb: newer, receivedAt: Math.max(at, prev?.receivedAt ?? 0), starts: kept });
    this.notify();
  }

  /**
   * Feed history oldest-first (e.g. `recentHealth`). Each record's wall-clock `ts` becomes a monotonic receive time
   * `now - max(0, wallNow - ts)`: a stamp in the future (a publisher clock ahead of this one) counts as received now.
   */
  // @spec CTRL-HEALTH-007, CTRL-HEALTH-009
  seed(history: { ts: number; data: HeartbeatData }[]): void {
    const wallNow = this.wall();
    const monoNow = this.now();
    for (const h of history) this.ingest(h.data, monoNow - Math.max(0, wallNow - h.ts));
  }

  /** Re-derive states (staleness is time-based) and notify listeners if anything changed. */
  tick(): void { this.notify(); }

  onChange(listener: (snapshot: ServiceHealth[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get(service: string): ServiceHealth {
    return this.derive(service);
  }

  /** Every known service plus any other that has sent a heartbeat. */
  // @spec CTRL-HEALTH-005
  snapshot(): ServiceHealth[] {
    const names = [...this.known];
    for (const s of this.entries.keys()) if (!names.includes(s)) names.push(s);
    return withNeeds(names.map((s) => this.derive(s)));
  }

  // @spec CTRL-HEALTH-001, CTRL-HEALTH-002, CTRL-HEALTH-003, CTRL-HEALTH-004
  private derive(service: string): ServiceHealth {
    const e = this.entries.get(service);
    if (!e) return { service, state: "unknown", restarts: 0 };
    const now = this.now();
    const age = Math.max(0, now - e.receivedAt);
    const restarts = e.starts.filter((s) => now - s.seenAt <= CRASH_LOOP_WINDOW_MS).length;
    const { hb } = e;
    let state: HealthState;
    if (restarts >= CRASH_LOOP_RESTARTS) state = "crash-looping";
    else if (hb.state === "stopping" || age > DOWN_FACTOR * hb.intervalMs) state = "down";
    else if (age > STALE_FACTOR * hb.intervalMs) state = "stale";
    else if (hb.state === "degraded" || hb.state === "starting" || Object.values(hb.deps).includes("down")) state = "degraded";
    else state = "up";
    return { service, state, heartbeat: hb, lastSeenAgeMs: age, restarts };
  }

  // @spec CTRL-HEALTH-006
  private notify(): void {
    if (this.listeners.size === 0) return;
    const snap = this.snapshot();
    let changed = false;
    for (const s of snap) {
      const h = s.heartbeat;
      const key = `${s.state}|${s.restarts}|${h ? `${h.state}|${h.mode}|${h.detail ?? ""}|${JSON.stringify(h.deps)}|${h.instance}` : ""}`;
      if (this.lastKeys.get(s.service) !== key) { this.lastKeys.set(s.service, key); changed = true; }
    }
    if (changed) for (const l of this.listeners) l(snap);
  }
}

/**
 * Overlays Compose container facts on a snapshot: each entry whose container has a restart count gets
 * `containerRestarts`, and an entry the heartbeats cannot vouch for (`unknown`, `stale`, `down`) whose container is
 * restarting, or is down after at least `CRASH_LOOP_RESTARTS` restarts, is reported `crash-looping`. This catches a
 * service that dies before its first heartbeat. Pure; a status without Docker changes nothing.
 */
// @spec CTRL-HEALTH-010
export function withContainerRestarts(snapshot: ServiceHealth[], status: StackStatus): ServiceHealth[] {
  if (!status.docker.ok) return snapshot;
  const byService = new Map(status.services.map((c) => [c.service, c]));
  const overlaid = snapshot.map((entry) => {
    const c = byService.get(entry.service);
    if (!c) return entry;
    const out: ServiceHealth = { ...entry, ...(c.restartCount !== undefined ? { containerRestarts: c.restartCount } : {}) };
    const unvouched = entry.state === "unknown" || entry.state === "stale" || entry.state === "down";
    const looping = c.status === "restarting" || (c.status !== "running" && (c.restartCount ?? 0) >= CRASH_LOOP_RESTARTS);
    if (unvouched && looping) out.state = "crash-looping";
    return out;
  });
  // A state the overlay changed can change another unit's needs; recompute only then, so an untouched snapshot stays as it came.
  return overlaid.some((e, i) => e.state !== snapshot[i]!.state) ? withNeeds(overlaid) : overlaid;
}
