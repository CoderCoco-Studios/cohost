import type { HeartbeatSpec } from "@cohost/shared";

/**
 * `off`: no output enabled. `local`: only the `dryrun`, `file` or `http` outputs are enabled. `discord`: the `discord`
 * output is enabled (and any of those beside it); it needs no account or client of mouth's own, only the Discord
 * connector's sink.
 */
export type MouthPlan = "off" | "local" | "discord";

/** The output kinds under `mouth.outputs`; each is one heartbeat dep and one sink name. */
export const OUTPUT_KINDS = ["discord", "dryrun", "file", "http"] as const;

/** The slice of `mouth.outputs` the plan and the heartbeat read: output name to whether it is enabled. */
export type OutputsEnabled = Partial<Record<string, { enabled: boolean }>>;

// @spec MOUTH-START-003, MOUTH-ROUTE-002
/** Pure decision for what mouth does at startup; never exits for a configuration gap. */
export function mouthPlan(outputs: OutputsEnabled): MouthPlan {
  if (outputs.discord?.enabled) return "discord";
  return (["dryrun", "file", "http"] as const).some((k) => outputs[k]?.enabled) ? "local" : "off";
}

// @spec MOUTH-HLTH-001, MOUTH-HLTH-002, MOUTH-DRY-004, MOUTH-LIVE-002
/**
 * mouth: mode `off` in the `off` plan, `mock` when only the dryrun output is enabled, else `live`; `deps` has one key per
 * output kind, `n/a` for a disabled output (or one switched off live), `ok` only while that output is ready and `down`
 * otherwise (the Discord output follows the connector's sink registration).
 */
export class MouthHealth {
  /** `isLive`: whether an output is not switched off by `set_routing` (default: every output is). */
  constructor(private plan: MouthPlan, private outputs: OutputsEnabled, private isReady: (output: string) => boolean, private isLive: (output: string) => boolean = () => true) {}

  private enabled(name: string): boolean { return !!this.outputs[name]?.enabled && this.isLive(name); }

  readonly spec: HeartbeatSpec = {
    service: "mouth",
    mode: () => (this.plan === "off" ? "off" : this.enabled("dryrun") && OUTPUT_KINDS.every((k) => k === "dryrun" || !this.enabled(k)) ? "mock" : "live"),
    deps: () => Object.fromEntries(OUTPUT_KINDS.map((name) => [name, !this.enabled(name) ? "n/a" : this.isReady(name) ? "ok" : "down"])),
  };
}
