import { tracked, type HeartbeatSpec } from "@cohost/bus";

/** eyes: `off` (deps n/a) when vision is disabled; otherwise obs follows the websocket and ollama the last describe call. */
export class EyesHealth {
  private ollama: "ok" | "down" = "ok";
  constructor(private enabled: boolean, private obsConnected: () => boolean) {}

  readonly spec: HeartbeatSpec = {
    service: "eyes",
    mode: () => (this.enabled ? "live" : "off"),
    deps: () => (this.enabled
      ? { obs: this.obsConnected() ? "ok" : "down", ollama: this.ollama }
      : { obs: "n/a", ollama: "n/a" }),
  };

  track(describe: (b64: string, previous: string) => Promise<string>) {
    return tracked(describe, (ok) => { this.ollama = ok ? "ok" : "down"; });
  }
}
