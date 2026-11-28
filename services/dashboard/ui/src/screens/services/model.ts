import type { HealthState, ProgressRowState, ServiceHealth, StackActionKind, StackProgress, StackSnapshot, UnitDescriptor } from "../../state/types";
import { needsAttention } from "../../state/derive";
import type { StatusInfo } from "../../components/Status";

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

export interface Why { /** The plain sentence for a service that is not ok, or a note on it; absent for an ok one. */ lead?: string; /** Muted: mode, dependency states and the heartbeat detail. */ rest?: string }

/**
 * The why cell of a service row (DASH-UI-007): a plain sentence first for a service that needs attention, in the
 * design's order of preference (a crash-loop, what it needs, the state itself), then, muted, the heartbeat's mode and
 * dependency states and its detail. A service never seen says it has not been started; the dashboard's own row says it is
 * this page.
 */
// @spec DASH-UI-007
export function whyOf(s: ServiceHealth): Why {
  if (s.service === "dashboard") return { lead: "This page. Runs on the host, so it has no controls here." };
  const hb = s.heartbeat;
  if (!hb && s.state !== "crash-looping" && !s.needs?.length) return { lead: "No heartbeat yet. It has not been started." };
  let lead: string | undefined;
  if (s.state === "crash-looping") lead = `${s.restarts} ${s.restarts === 1 ? "restart" : "restarts"} in the last minute`;
  else if (s.needs?.length) lead = `Needs ${s.needs.map((n) => `${n.service} (${n.state})`).join(", ")}`;
  else if (!(s.state === "degraded" && hb?.state === "starting")) lead = STATE_WHY[s.state];
  const deps = Object.entries(hb?.deps ?? {}).map(([k, v]) => `${k} ${v}`);
  const rest = [typeof hb?.mode === "string" ? hb.mode : "", deps.length ? `deps: ${deps.join(", ")}` : "", typeof hb?.detail === "string" ? hb.detail : ""].filter(Boolean).join(" · ");
  return { lead, rest: rest || undefined };
}

/** A past span in plain words: `42 seconds`, `1 minute`, `14 minutes`, `3 hours`. */
export function agoWords(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const unit = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  return s < 60 ? unit(s, "second") : s < 3600 ? unit(Math.floor(s / 60), "minute") : unit(Math.floor(s / 3600), "hour");
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

/** A container of the stack snapshot. */
export type Container = StackSnapshot["services"][number];

/**
 * An Infrastructure row's state from Docker's view (DASH-UI-065, DASH-UI-066): an exited one-shot reads `completed` on exit 0
 * and `failed (exit n)` otherwise; a running container is ok unless its health says otherwise; the word carries the health.
 */
// @spec DASH-UI-065, DASH-UI-066
export function containerStatus(c: Pick<Container, "status" | "health" | "oneShot" | "exitCode">): StatusInfo {
  if (c.oneShot && c.status === "exited" && c.exitCode !== undefined) {
    return c.exitCode === 0 ? { status: "ok", word: "completed" } : { status: "bad", word: `failed (exit ${c.exitCode})` };
  }
  const word = c.health ? `${c.status}, ${c.health}` : c.status;
  if (c.status === "running") return { status: c.health === "unhealthy" ? "bad" : c.health === "starting" ? "building" : "ok", word };
  if (c.status === "restarting") return { status: "warn", word };
  if (c.status === "dead") return { status: "bad", word };
  return { status: "stopped", word };
}

/** The containers of the snapshot that have no row of their own in the `services` message, by service name (DASH-UI-065). */
export function infraContainers(stack: StackSnapshot | null, services: readonly Pick<ServiceHealth, "service">[] | null): Container[] {
  const rows = new Set((services ?? []).map((s) => s.service));
  return (stack?.services ?? []).filter((c) => !rows.has(c.service)).toSorted((a, b) => (a.service < b.service ? -1 : a.service > b.service ? 1 : 0));
}

/** A launch progress row's state in words (DASH-UI-055). */
export function rowStateWords(s: ProgressRowState): string {
  return s; // building, cached, built, failed, restarting, done read as they are
}

/** Whether the recorded action is running, finished or failed (DASH-UI-055). */
export function outcomeWords(p: Pick<StackProgress, "running" | "ok">): string {
  return p.running ? "running" : p.ok ? "finished" : "failed";
}

/** The Docker restart count of a service row, `1 restart` or `n restarts`; empty when the probe has not given one (DASH-UI-059). */
// @spec DASH-UI-059
export function restartLine(s: Pick<ServiceHealth, "containerRestarts">): string {
  const n = s.containerRestarts;
  return n === undefined ? "" : `${n} ${n === 1 ? "restart" : "restarts"}`;
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

/** Services whose derived state is up, of all listed: `2 of 3 services healthy`. */
export function healthySummary(list: readonly Pick<ServiceHealth, "state">[]): string {
  return `${list.filter((x) => x.state === "up").length} of ${list.length} services healthy`;
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
