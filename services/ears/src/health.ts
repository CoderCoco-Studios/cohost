import { tracked, type HeartbeatSpec } from "@cohost/shared";

export type EarsSource = "discord" | "off";
/** `off`: source=off. `no-token`: discord without a usable EARS_DISCORD_TOKEN (idle, degraded). `discord`: run the bot. */
export type EarsPlan = "off" | "no-token" | "discord";

// @spec EARS-START-004
/** Pure decision for what ears does at startup; never exits for a configuration gap. */
export function earsPlan(source: EarsSource, hasToken: boolean): EarsPlan {
  if (source === "off") return "off";
  return hasToken ? "discord" : "no-token";
}

/** What the environment says about ears' bot token. */
export interface EarsToken {
  /** `EARS_DISCORD_TOKEN`, or the empty string. */
  token: string;
  /** True only when the token is non-empty and differs from `DISCORD_TOKEN`. */
  hasToken: boolean;
  /** True when the token equals the non-empty `DISCORD_TOKEN` (the mouth bot's). */
  conflict: boolean;
}

// @spec EARS-START-004, EARS-START-007, EARS-SESS-009
/**
 * ears' bot token is `EARS_DISCORD_TOKEN` and nothing else: `DISCORD_TOKEN` (mouth's bot) is read only to refuse a token
 * that equals it, because one bot in two processes would make both voice connections displace each other.
 */
export function readEarsToken(e: Record<string, string | undefined> = process.env): EarsToken {
  const token = e.EARS_DISCORD_TOKEN ?? "";
  const mouthToken = e.DISCORD_TOKEN ?? "";
  const conflict = token !== "" && token === mouthToken;
  return { token, hasToken: token !== "" && !conflict, conflict };
}

// @spec EARS-START-002, EARS-START-007
/** The heartbeat detail and log text for the `no-token` plan. */
export function idleDetail(t: EarsToken): string {
  return t.conflict
    ? "EARS_DISCORD_TOKEN is the mouth bot's DISCORD_TOKEN; ears needs a bot of its own"
    : "EARS_DISCORD_TOKEN is not set";
}

// @spec EARS-HLTH-001, EARS-HLTH-002, EARS-HLTH-003, EARS-STUB-002
/**
 * ears: `off` (mode off, deps n/a) for source=off; otherwise mode live (`mock` with the stub engine, whose stt is n/a)
 * with discord following the gateway session (down without a token) and stt the last transcription.
 */
export class EarsHealth {
  private stt: "ok" | "down" = "ok";
  constructor(private plan: EarsPlan, private discordReady: () => boolean, private stub = false) {}

  readonly spec: HeartbeatSpec = {
    service: "ears",
    mode: () => (this.plan === "off" ? "off" : this.stub ? "mock" : "live"),
    deps: () => (this.plan === "off"
      ? { discord: "n/a", stt: "n/a" }
      : { discord: this.plan === "discord" && this.discordReady() ? "ok" : "down", stt: this.stub ? "n/a" : this.stt }),
  };

  track<A extends unknown[]>(transcribe: (...a: A) => Promise<string>) {
    return tracked(transcribe, (ok) => { this.stt = ok ? "ok" : "down"; });
  }
}
