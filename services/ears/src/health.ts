import { tracked, type HeartbeatSpec } from "@cohost/shared";

/** One enabled listening source in the plan. `gap` is set when it cannot run for lack of configuration. */
export interface PlannedSource {
  name: string;
  kind: "discord" | "http" | "dir" | "connector";
  gap?: string;
}

/** The set of sources to start (`sources`) and the ones among them that can run (`runnable`); empty `sources` is `off`. */
export interface EarsPlan {
  sources: PlannedSource[];
  runnable: PlannedSource[];
}

// @spec EARS-SRC-003, EARS-SRC-001, EARS-START-004
/**
 * Pure decision for what ears starts: one entry per distinct source name. A `dir` source without a path is a gap, and so
 * is `discord` (the legacy in-process client) when `discordGap` says why it cannot run; any other name is a connector tag
 * and always runnable. Never exits for a configuration gap.
 */
export function earsPlan(sources: readonly string[], hasDirPath: boolean, discordGap?: string): EarsPlan {
  const planned = [...new Set(sources)].map((name): PlannedSource => {
    if (name === "http") return { name, kind: "http" };
    if (name === "dir") return hasDirPath ? { name, kind: "dir" } : { name, kind: "dir", gap: "ears.dir.path is not set" };
    if (name === "discord") return discordGap === undefined ? { name, kind: "discord" } : { name, kind: "discord", gap: discordGap };
    return { name, kind: "connector" };
  });
  return { sources: planned, runnable: planned.filter((x) => x.gap === undefined) };
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

// @spec EARS-HLTH-001, EARS-HLTH-003, EARS-SRC-005, EARS-STUB-002
/**
 * ears: mode `off` with every dep n/a when no source is enabled; otherwise mode live (`mock` with the stub engine, whose
 * stt is n/a). One dep per enabled source named for it (`discord`, `http`, `dir` or the connector tag), `n/a` for the
 * three fixed names when not enabled; a gap source is `down`, `discord` follows the gateway session, every other source
 * follows `sourceStatus`. `stt` is the last transcription, shared by all sources.
 */
export class EarsHealth {
  private stt: "ok" | "down" = "ok";
  constructor(
    private plan: EarsPlan,
    private discordReady: () => boolean,
    private stub = false,
    private sourceStatus: (name: string) => "ok" | "down" = () => "down",
  ) {}

  readonly spec: HeartbeatSpec = {
    service: "ears",
    mode: () => (this.plan.sources.length === 0 ? "off" : this.stub ? "mock" : "live"),
    deps: (): Record<string, "ok" | "down" | "n/a"> => {
      if (this.plan.sources.length === 0) return { discord: "n/a", stt: "n/a" };
      const deps: Record<string, "ok" | "down" | "n/a"> = { discord: "n/a", http: "n/a", dir: "n/a", stt: this.stub ? "n/a" : this.stt };
      for (const src of this.plan.sources) {
        deps[src.name] = src.gap !== undefined ? "down" : src.kind === "discord" ? (this.discordReady() ? "ok" : "down") : this.sourceStatus(src.name);
      }
      return deps;
    },
  };

  track<A extends unknown[]>(transcribe: (...a: A) => Promise<string>) {
    return tracked(transcribe, (ok) => { this.stt = ok ? "ok" : "down"; });
  }
}
