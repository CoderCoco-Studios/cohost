/** Wire types of the dashboard's HTTP routes and `/ws` feed, as the UI uses them (design: HTTP surface, Feed and health). */

export type HealthState = "up" | "degraded" | "stale" | "down" | "unknown" | "crash-looping";

export interface Heartbeat {
  service: string;
  mode?: string;
  detail?: string;
  startedAt?: number;
  deps?: Record<string, string>;
  [key: string]: unknown;
}

export interface ServiceHealth {
  service: string;
  state: HealthState;
  heartbeat?: Heartbeat;
  /** Milliseconds since the latest heartbeat, at the moment the snapshot was sent. */
  lastSeenAgeMs?: number;
  restarts: number;
  containerRestarts?: number;
  needs?: { service: string; state: HealthState }[];
}

export type StackState = "docker-unavailable" | "down" | "starting" | "up" | "degraded" | "stopping";
export type StackActionKind = "launch" | "stop" | "restart" | "consolidate" | "rebuild";

export interface StackSnapshot {
  state: StackState;
  docker: { ok: boolean; detail?: string };
  bus: "connected" | "unreachable";
  action: null | { kind: StackActionKind; phase: string; startedAt: number };
  last: null | { kind: StackActionKind; ok: boolean; detail?: string; services?: { service: string; status: string; health?: string }[]; finishedAt: number };
  services: { service: string; status: string; health?: string; restartCount?: number; overrides?: Record<string, string> }[];
}

/** A bus event as `/ws` carries it; `replay` is set by the server on the connect replay only. */
export interface FeedEvent {
  id: string;
  type: string;
  ts: number;
  source: string;
  data: Record<string, unknown>;
  replay?: boolean;
}

/** The `GET /services/control` answer. */
export type ControlInfo = ({ enabled: false } | { enabled: true; runtime: string; advanced: boolean }) & {
  /** True when the full surface is bound beyond loopback: only then does a gated request need the control token (DASH-CTRL-011). */
  tokenRequired: boolean;
};

/** The `GET /services/manifest` unit descriptors (only what the shell and screens read). */
export interface UnitDescriptor {
  id: string;
  config: unknown;
  uses: string[];
  requires: string[];
  pause: boolean;
  test: unknown;
  infra: boolean;
  defaultMode: string;
}

export type TokenKind = "control" | "viewers";
