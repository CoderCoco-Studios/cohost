import { tracked, type HeartbeatSpec } from "@cohost/bus";

/** ears: `off` without a Discord token; otherwise discord follows the gateway session and stt the last transcription. */
export class EarsHealth {
  private stt: "ok" | "down" = "ok";
  constructor(private hasToken: boolean, private discordReady: () => boolean) {}

  readonly spec: HeartbeatSpec = {
    service: "ears",
    mode: () => (this.hasToken ? "live" : "off"),
    deps: () => ({ discord: !this.hasToken ? "n/a" : this.discordReady() ? "ok" : "down", stt: this.stt }),
  };

  track(transcribe: (wav: Buffer) => Promise<string>) {
    return tracked(transcribe, (ok) => { this.stt = ok ? "ok" : "down"; });
  }
}
