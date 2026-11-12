import type { HeartbeatSpec } from "@cohost/shared";

/**
 * `off`: no output enabled. `no-token`: the discord output is the only one enabled and DISCORD_TOKEN is missing (idle,
 * degraded). `local`: a `dryrun`, `file` or `http` output runs with no Discord client. `discord`: run the bot (and any of those beside it).
 */
export type MouthPlan = "off" | "no-token" | "local" | "discord";

/** The output kinds under `mouth.outputs`; each is one heartbeat dep and one sink name. */
export const OUTPUT_KINDS = ["discord", "dryrun", "file", "http"] as const;

/** The kinds that need no account or device, so they run with no Discord client (the `local` plan). */
const LOCAL_KINDS = ["dryrun", "file", "http"] as const;

/** The slice of `mouth.outputs` the plan and the heartbeat read: output name to whether it is enabled. */
export type OutputsEnabled = Partial<Record<string, { enabled: boolean }>>;

// @spec MOUTH-START-003, MOUTH-ROUTE-002
/** Pure decision for what mouth does at startup; never exits for a configuration gap. */
export function mouthPlan(outputs: OutputsEnabled, hasToken: boolean): MouthPlan {
  const discord = !!outputs.discord?.enabled;
  if (LOCAL_KINDS.some((k) => outputs[k]?.enabled)) return discord && hasToken ? "discord" : "local";
  if (!discord) return "off";
  return hasToken ? "discord" : "no-token";
}

// @spec MOUTH-SESS-008
/** The co-host's bot token: `DISCORD_TOKEN`, and no other Discord token variable (ears' is `EARS_DISCORD_TOKEN`). */
export function readToken(e: Record<string, string | undefined> = process.env): string {
  return e.DISCORD_TOKEN ?? "";
}

// @spec MOUTH-HLTH-001, MOUTH-HLTH-002, MOUTH-DRY-004, MOUTH-LIVE-002
/**
 * mouth: mode `off` in the `off` plan, `mock` when only the dryrun output is enabled, else `live`; `deps` has one key per
 * output kind, `n/a` for a disabled output (or one switched off live), `ok` only while that output is ready and `down`
 * otherwise (the Discord output is always down in `no-token`).
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
