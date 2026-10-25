import { tracked, type HeartbeatSpec } from "@cohost/bus";

export type EarsSource = "discord" | "off";
/** `off`: source=off. `no-token`: discord without DISCORD_TOKEN (idle, degraded). `discord`: run the bot. */
export type EarsPlan = "off" | "no-token" | "discord";

/** Pure decision for what ears does at startup; never exits for a configuration gap. */
export function earsPlan(source: EarsSource, hasToken: boolean): EarsPlan {
  if (source === "off") return "off";
  return hasToken ? "discord" : "no-token";
}

/**
 * ears: `off` (mode off, deps n/a) for source=off; otherwise mode live with discord following the
 * gateway session (down without a token) and stt the last transcription.
 */
export class EarsHealth {
  private stt: "ok" | "down" = "ok";
  constructor(private plan: EarsPlan, private discordReady: () => boolean) {}

  readonly spec: HeartbeatSpec = {
    service: "ears",
    mode: () => (this.plan === "off" ? "off" : "live"),
    deps: () => (this.plan === "off"
      ? { discord: "n/a", stt: "n/a" }
      : { discord: this.plan === "discord" && this.discordReady() ? "ok" : "down", stt: this.stt }),
  };

  track(transcribe: (wav: Buffer) => Promise<string>) {
    return tracked(transcribe, (ok) => { this.stt = ok ? "ok" : "down"; });
  }
}
