import { tracked, type HeartbeatSpec } from "@cohost/shared";

// @spec EYES-HEALTH-001, EYES-HEALTH-002, EYES-HEALTH-003, EYES-HEALTH-004, EYES-STUB-002
/** eyes: `off` (deps n/a) when vision is disabled; otherwise obs follows the websocket and ollama the last describe call. The stub engine reports mode `mock` and ollama `n/a`. */
export class EyesHealth {
  private ollama: "ok" | "down" = "ok";
  constructor(private enabled: boolean, private obsConnected: () => boolean, private engine: "ollama" | "stub" = "ollama") {}

  readonly spec: HeartbeatSpec = {
    service: "eyes",
    mode: () => (this.enabled ? (this.engine === "stub" ? "mock" : "live") : "off"),
    deps: () => (this.enabled
      ? { obs: this.obsConnected() ? "ok" : "down", ollama: this.engine === "stub" ? "n/a" : this.ollama }
      : { obs: "n/a", ollama: "n/a" }),
  };

  track(describe: (b64: string, previous: string) => Promise<string>) {
    return tracked(describe, (ok) => { this.ollama = ok ? "ok" : "down"; });
  }
}
