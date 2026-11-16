import type { HealthState, ServiceHealth, StackActionKind, StackSnapshot, UnitDescriptor } from "../../state/types";
import { needsAttention } from "../../state/derive";

/** `45s`, or `2m 05s` from a minute up. Negative spans (a skewed clock) read as `0s`. */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** A service's last-seen age at page time `now`: the snapshot's age plus the time since it arrived; `never` when no heartbeat was seen. */
export function lastSeen(s: Pick<ServiceHealth, "lastSeenAgeMs">, arrivedAt: number, now: number): string {
  return s.lastSeenAgeMs == null ? "never" : `${elapsed(s.lastSeenAgeMs + Math.max(0, now - arrivedAt))} ago`;
}

const STATE_WHY: Partial<Record<HealthState, string>> = {
  stale: "Heartbeats have stopped; the service may be hung or stopped.",
  down: "No heartbeat for a long time; it is probably not running.",
  degraded: "It reports a problem without saying what.",
};

/**
 * The one-sentence "why" of a service row, in the design's order of preference: a crash-loop, what the service needs,
 * the heartbeat's own detail, then (for a state that is not ok) a plain sentence for the state, then mode and dependency
 * states. A service never seen says it has not been started; the dashboard's own row says it is this page (DASH-UI-007).
 */
// @spec DASH-UI-007
export function whyOf(s: ServiceHealth): string {
  if (s.service === "dashboard") return "This page. It has no controls.";
  const hb = s.heartbeat;
  if (s.state === "crash-looping") return `${s.restarts} ${s.restarts === 1 ? "restart" : "restarts"} in the last minute`;
  if (s.needs?.length) return `Needs ${s.needs.map((n) => `${n.service} (${n.state})`).join(", ")}`;
  if (typeof hb?.detail === "string" && hb.detail !== "") return hb.detail;
  if (!hb) return "No heartbeat yet. It has not been started.";
  const byState = STATE_WHY[s.state];
  if (byState) return byState;
  const deps = Object.entries(hb.deps ?? {}).map(([k, v]) => `${k} ${v}`);
  const parts = [typeof hb.mode === "string" ? hb.mode : "", deps.length ? `deps: ${deps.join(", ")}` : ""].filter(Boolean);
  return parts.length ? parts.join(" · ") : "Running normally.";
}

/** Rows needing attention (down, crash-looping, stale) first; each group keeps the snapshot's (manifest) order. */
export function sortServices(list: readonly ServiceHealth[]): ServiceHealth[] {
  return [...list.filter(needsAttention), ...list.filter((s) => !needsAttention(s))];
}

/** What a stack action's phase means, in words (DASH-UI-020). */
export function phaseWords(phase: string): string {
  if (phase === "compose-build") return "building images and starting containers";
  if (phase === "waiting") return "waiting for every service";
  if (phase === "starting") return "starting";
  return phase; // `stopping`, `running`, `restarting <service>` read as they are
}

/** The step of a launch or rebuild: 1 while building, 2 while waiting; other kinds have none. */
export function stackStep(kind: StackActionKind, phase: string): 1 | 2 | undefined {
  if (kind !== "launch" && kind !== "rebuild") return undefined;
  return phase === "waiting" ? 2 : 1;
}

export const KIND_LABEL: Record<StackActionKind, string> = { launch: "Launch", rebuild: "Rebuild", restart: "Restart all", stop: "Stop", consolidate: "Consolidation" };

/** The sentence of cause under the stack's state (DASH-UI-018). */
export function stackCause(s: StackSnapshot): string[] {
  const out: string[] = [];
  if (s.state === "docker-unavailable" || !s.docker.ok) out.push(`Docker is unavailable${s.docker.detail ? `: ${s.docker.detail}` : "."}`);
  else if (s.state === "down") out.push("Nothing is running. The stack is down.");
  else out.push("Docker is running.");
  if (s.bus === "unreachable") out.push("The bus (Redis) is not reachable. Mute, say and test inputs cannot be sent.");
  else if (s.docker.ok && s.state !== "down") out.push("The bus (Redis) is connected.");
  return out;
}

/** Why a start, restart, stop or stack action cannot be sent right now, or undefined (DASH-UI-008). */
export function blockReason(stack: StackSnapshot | null): string | undefined {
  if (!stack) return undefined;
  if (stack.action) return "A stack action is running.";
  if (!stack.docker.ok) return `Docker is unavailable${stack.docker.detail ? `: ${stack.docker.detail}` : "."}`;
  return undefined;
}

export interface UnitTest { inputs: string[]; observe: string[] }
/** The unit's declared test inputs and observed event types, whatever shape the manifest sent. */
export function unitTest(u: UnitDescriptor): UnitTest {
  const t = (u.test ?? {}) as { inputs?: unknown; observe?: unknown };
  const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return { inputs: strs(t.inputs), observe: strs(t.observe) };
}
