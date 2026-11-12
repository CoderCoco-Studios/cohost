/**
 * Live routing: the in-memory override of which running outputs are on and how loud `discord` is, changed by the bus command
 * `set_routing` and lost on restart (config.yaml stays the persisted routing). It can only switch outputs mouth already
 * started; it never builds one, so it never creates a Discord client.
 */
import type { Logger } from "@cohost/config";
import type { ControlData, Heartbeat } from "@cohost/shared";
import { OUTPUT_KINDS } from "./health.js";

/** The `gain_db` range the config schema allows. */
const GAIN_MIN = -40;
const GAIN_MAX = 12;

/** The running outputs, by name; an entry carries `gain_db` only for an output that has a gain (`discord`). */
export type RunningOutputs = Record<string, { gain_db?: number }>;

export type RoutingResult = { ok: true } | { ok: false; reason: string };

interface State { enabled: boolean; gain_db?: number }

// @spec MOUTH-LIVE-002, MOUTH-LIVE-003, MOUTH-LIVE-005, MOUTH-LIVE-006
export class Routing {
  private state = new Map<string, State>();

  /** Every running output starts enabled, at its configured gain. */
  constructor(running: RunningOutputs) {
    for (const [name, o] of Object.entries(running)) this.state.set(name, { enabled: true, ...(o.gain_db !== undefined ? { gain_db: o.gain_db } : {}) });
  }

  /** Whether the output is running and not switched off live. */
  isEnabled(name: string): boolean { return this.state.get(name)?.enabled ?? false; }

  /** Whether `set_routing` switched the output off (an output that is not running is not switched off, it is absent). */
  isSwitchedOff(name: string): boolean { return this.state.get(name)?.enabled === false; }

  gainDb(name: string): number { return this.state.get(name)?.gain_db ?? 0; }

  /** Apply a `routing` map whole, or change nothing and say why. */
  apply(patch: unknown): RoutingResult {
    if (typeof patch !== "object" || patch === null || Array.isArray(patch) || Object.keys(patch).length === 0) return { ok: false, reason: "no routing entries" };
    const next = new Map<string, State>();
    for (const [name, entry] of Object.entries(patch)) {
      if (!(OUTPUT_KINDS as readonly string[]).includes(name)) return { ok: false, reason: `unknown output id "${name}"` };
      const cur = this.state.get(name);
      if (!cur) return { ok: false, reason: `output "${name}" is not running` };
      const e = (typeof entry === "object" && entry !== null ? entry : {}) as { enabled?: unknown; gain_db?: unknown };
      const merged: State = { ...cur };
      if (e.enabled !== undefined) {
        if (typeof e.enabled !== "boolean") return { ok: false, reason: `enabled for "${name}" is not a boolean` };
        merged.enabled = e.enabled;
      }
      if (e.gain_db !== undefined) {
        if (cur.gain_db === undefined) return { ok: false, reason: `output "${name}" has no gain_db` };
        if (typeof e.gain_db !== "number" || !Number.isFinite(e.gain_db) || e.gain_db < GAIN_MIN || e.gain_db > GAIN_MAX) return { ok: false, reason: `gain_db out of range for "${name}" (${GAIN_MIN} to ${GAIN_MAX})` };
        merged.gain_db = e.gain_db;
      }
      next.set(name, merged);
    }
    for (const [name, s] of next) this.state.set(name, s);
    return { ok: true };
  }

  /** The heartbeat's standing detail: the current routing in the shape of the `mouth.outputs` config keys. */
  detail(rejected?: string): string {
    const view: Record<string, State> = {};
    for (const name of OUTPUT_KINDS) {
      const s = this.state.get(name);
      if (s) view[name] = s;
    }
    return `${rejected ? `set_routing rejected: ${rejected}; ` : ""}routing ${JSON.stringify(view)}`;
  }
}

/** The `controlFor` handler for `set_routing`: apply, warn on a rejection, and report the outcome as the heartbeat detail. */
// @spec MOUTH-LIVE-001, MOUTH-LIVE-003, MOUTH-LIVE-006
export function setRoutingHandler(routing: Routing, deps: { heartbeat: Pick<Heartbeat, "setDetail">; log: Pick<Logger, "warn"> }) {
  return (d: ControlData): void => {
    const res = routing.apply(d.routing);
    if (!res.ok) deps.log.warn({ reason: res.reason }, "set_routing rejected");
    deps.heartbeat.setDetail(routing.detail(res.ok ? undefined : res.reason));
  };
}
