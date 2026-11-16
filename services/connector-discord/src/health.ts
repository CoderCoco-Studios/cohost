import type { Config } from "@cohost/config";
import type { HeartbeatSpec } from "@cohost/shared";

/** `off`: `connections.discord.enabled` is false. `no-token`: `connections.discord.token` is unset or empty. `run`: log in and hold the voice connection. */
export type ConnectorPlan = "off" | "no-token" | "run";

// @spec CONN-DISC-002, CONN-DISC-011
/** Pure decision for what the connector does at startup; it never exits for a configuration gap. */
export function connectorPlan(enabled: boolean, hasToken: boolean): ConnectorPlan {
  if (!enabled) return "off";
  return hasToken ? "run" : "no-token";
}

// @spec CONN-DISC-001
/** The bot's token: `connections.discord.token` of the loaded config, and no other source. */
export function readToken(cfg: Config): string {
  return cfg.connections.discord.token.trim();
}

/** What the heartbeat reads from the running connector. */
export interface ConnectorStatus {
  /** The voice connection is Ready. */
  voiceReady(): boolean;
  /** The capability is registered `ready` (not absent through a tag conflict) and, for `audio-in`, capture runs. */
  audioIn(): boolean;
  audioOut(): boolean;
}

// @spec CONN-HLTH-001
/**
 * Service `connector-discord`: mode `live` (`off` when disabled) and deps `discord`, `audio-in`, `audio-out`: `discord` ok only while the
 * voice connection is Ready, each audio dep ok while its capability is registered ready, down otherwise (`n/a` when disabled).
 */
export function connectorHealth(plan: ConnectorPlan, s: ConnectorStatus): HeartbeatSpec {
  const dep = (ok: () => boolean) => (): "ok" | "down" | "n/a" => (plan === "off" ? "n/a" : plan === "run" && ok() ? "ok" : "down");
  const probes = { discord: dep(s.voiceReady), "audio-in": dep(s.audioIn), "audio-out": dep(s.audioOut) };
  return {
    service: "connector-discord", // the process name; the connector id and tag are `discord`
    mode: plan === "off" ? "off" : "live",
    deps: () => Object.fromEntries(Object.entries(probes).map(([k, f]) => [k, f()])),
  };
}
