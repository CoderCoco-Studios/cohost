import type { HeartbeatSpec } from "@cohost/shared";

/**
 * `off`: no output enabled. `no-token`: the discord output is the only one enabled and DISCORD_TOKEN is missing (idle,
 * degraded). `local`: the dryrun output runs with no Discord client. `discord`: run the bot (and any dryrun beside it).
 */
export type MouthPlan = "off" | "no-token" | "local" | "discord";

/** The output kinds under `mouth.outputs`; each is one heartbeat dep and one sink name. */
export const OUTPUT_KINDS = ["discord", "dryrun"] as const;

/** The slice of `mouth.outputs` the plan and the heartbeat read: output name to whether it is enabled. */
export type OutputsEnabled = Partial<Record<string, { enabled: boolean }>>;

// @spec MOUTH-START-003, MOUTH-ROUTE-002
/** Pure decision for what mouth does at startup; never exits for a configuration gap. */
export function mouthPlan(outputs: OutputsEnabled, hasToken: boolean): MouthPlan {
  const discord = !!outputs.discord?.enabled;
  if (outputs.dryrun?.enabled) return discord && hasToken ? "discord" : "local";
  if (!discord) return "off";
  return hasToken ? "discord" : "no-token";
}

// @spec MOUTH-SESS-008
/** The co-host's bot token: `DISCORD_TOKEN`, and no other Discord token variable (ears' is `EARS_DISCORD_TOKEN`). */
export function readToken(e: Record<string, string | undefined> = process.env): string {
  return e.DISCORD_TOKEN ?? "";
}

// @spec MOUTH-HLTH-001, MOUTH-HLTH-002, MOUTH-DRY-004
/**
 * mouth: mode `off` in the `off` plan, `mock` when only the dryrun output is enabled, else `live`; `deps` has one key per
 * output kind, `n/a` for a disabled output, `ok` only while that output is ready and `down` otherwise (the Discord
 * output is always down in `no-token`).
 */
export class MouthHealth {
  constructor(private plan: MouthPlan, private outputs: OutputsEnabled, private isReady: (output: string) => boolean) {}

  private enabled(name: string): boolean { return !!this.outputs[name]?.enabled; }

  readonly spec: HeartbeatSpec = {
    service: "mouth",
    mode: () => (this.plan === "off" ? "off" : this.enabled("dryrun") && !this.enabled("discord") ? "mock" : "live"),
    deps: () => Object.fromEntries(OUTPUT_KINDS.map((name) => [name, !this.enabled(name) ? "n/a" : this.isReady(name) ? "ok" : "down"])),
  };
}
