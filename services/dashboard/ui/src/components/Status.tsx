
import type { ServiceHealth, StackState } from "../state/types";
import type { ReactNode } from "react";
export type StatusKind = "ok" | "warn" | "bad" | "building" | "stopped";

const SHAPES: Record<StatusKind, ReactNode> = {
  ok: <circle cx="6" cy="6" r="5" fill="currentColor" />,
  warn: <path d="M6 1 11.5 11h-11z" fill="currentColor" />,
  bad: <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" fill="none" />,
  building: <circle className="spin" cx="6" cy="6" r="4.2" fill="none" stroke="currentColor" strokeWidth="2.2" strokeDasharray="14 12" strokeLinecap="round" />,
  stopped: <circle cx="6" cy="6" r="4.4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeDasharray="2 2" />,
};

/**
 * One status: a shape (filled circle, triangle, cross, open ring, dashed ring), the word, and a colour class, so none
 * depends on hue alone (DASH-THEME-004). The building ring spins unless the user prefers reduced motion (DASH-THEME-005).
 */
// @spec DASH-THEME-004
export function Status({ status, label, plain }: { status: StatusKind; label: string; /** No pill background (inline in a sentence). */ plain?: boolean }) {
  return (
    <span className={`st st-${status}${plain ? " st-plain" : ""}`} title={label}>
      <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false">{SHAPES[status]}</svg>
      {label}
    </span>
  );
}

export interface StatusInfo { status: StatusKind; word: string }

/** A service's state as a status, per the design's table; a `degraded` unit whose heartbeat says `starting` is Starting. */
// @spec DASH-THEME-004
export function serviceStatus(h: Pick<ServiceHealth, "state" | "heartbeat">): StatusInfo {
  switch (h.state) {
    case "up": return { status: "ok", word: "Up" };
    case "degraded": return h.heartbeat?.state === "starting" ? { status: "building", word: "Starting" } : { status: "warn", word: "Degraded" };
    case "stale": return { status: "warn", word: "Stale" };
    case "down": return { status: "bad", word: "Down" };
    case "crash-looping": return { status: "bad", word: "Crash-looping" };
    default: return { status: "stopped", word: "Unknown" };
  }
}

/** The stack's state as a status, per the design's table. */
// @spec DASH-THEME-004
export function stackStatus(state: StackState): StatusInfo {
  switch (state) {
    case "up": return { status: "ok", word: "Up" };
    case "degraded": return { status: "warn", word: "Degraded" };
    case "docker-unavailable": return { status: "bad", word: "Docker unavailable" };
    case "starting": return { status: "building", word: "Starting" };
    case "stopping": return { status: "building", word: "Stopping" };
    default: return { status: "stopped", word: "Down" };
  }
}
