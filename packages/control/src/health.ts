import type { EventData } from "@cohost/bus";

export type HeartbeatData = EventData<"service.heartbeat">;

export type HealthState = "up" | "degraded" | "stale" | "down" | "unknown" | "crash-looping";

/** The 10 cohost services; always present in a snapshot even if never seen. */
export const KNOWN_SERVICES = [
  "chat", "salience", "affect", "memory", "cortex", "voice", "avatar", "eyes", "ears", "dashboard",
] as const;

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
}

export interface HealthTrackerOptions {
  /** Injectable clock for tests. */
  now?: () => number;
  /** Service names always listed in snapshots. */
  known?: readonly string[];
}

interface Entry {
  hb: HeartbeatData;
  receivedAt: number;
  /** First time each distinct startedAt was seen (receive clock). */
  starts: { startedAt: number; seenAt: number }[];
}

/**
 * Derives per-service health from heartbeats using its own receive-time clock
 * (so clock skew between containers is irrelevant). Derived states are never
 * published. See openspec/specs/service-health.
 */
export class HealthTracker {
  private entries = new Map<string, Entry>();
  private listeners = new Set<(snapshot: ServiceHealth[]) => void>();
  private lastKeys = new Map<string, string>();
  private readonly now: () => number;
  private readonly known: readonly string[];

  constructor(opts: HealthTrackerOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.known = opts.known ?? KNOWN_SERVICES;
  }

  /** Record a heartbeat. `at` defaults to now; pass a past time when seeding from history. */
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

  /** Feed history oldest-first (e.g. `recentHealth`); `ts` of each is its receive time. */
  seed(history: { ts: number; data: HeartbeatData }[]): void {
    for (const h of history) this.ingest(h.data, h.ts);
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
  snapshot(): ServiceHealth[] {
    const names = [...this.known];
    for (const s of this.entries.keys()) if (!names.includes(s)) names.push(s);
    return names.map((s) => this.derive(s));
  }

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
