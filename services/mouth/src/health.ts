import type { HeartbeatSpec } from "@cohost/shared";

/** `off`: no output enabled. `no-token`: the discord output is enabled without DISCORD_TOKEN (idle, degraded). `discord`: run the bot. */
export type MouthPlan = "off" | "no-token" | "discord";

/** The slice of `mouth.outputs` the plan and the heartbeat read: output name to whether it is enabled. */
export type OutputsEnabled = Record<string, { enabled: boolean }>;

// @spec MOUTH-START-003, MOUTH-ROUTE-002
/** Pure decision for what mouth does at startup; never exits for a configuration gap. */
export function mouthPlan(outputs: OutputsEnabled, hasToken: boolean): MouthPlan {
  if (!outputs.discord?.enabled) return "off";
  return hasToken ? "discord" : "no-token";
}

// @spec MOUTH-SESS-008
/** The co-host's bot token: `DISCORD_TOKEN`, and no other Discord token variable (ears' is `EARS_DISCORD_TOKEN`). */
export function readToken(e: Record<string, string | undefined> = process.env): string {
  return e.DISCORD_TOKEN ?? "";
}

// @spec MOUTH-HLTH-001, MOUTH-HLTH-002
/**
 * mouth: mode `off` in the `off` plan, else `live`; `deps` has one key per output, `n/a` for a disabled output,
 * `ok` only while that output is ready and `down` otherwise (always down in `no-token`).
 */
export class MouthHealth {
  constructor(private plan: MouthPlan, private outputs: OutputsEnabled, private isReady: (output: string) => boolean) {}

  readonly spec: HeartbeatSpec = {
    service: "mouth",
    mode: () => (this.plan === "off" ? "off" : "live"),
    deps: () => Object.fromEntries(Object.entries(this.outputs).map(([name, o]) => [
      name,
      !o.enabled ? "n/a" : this.plan === "discord" && this.isReady(name) ? "ok" : "down",
    ])),
  };
}
