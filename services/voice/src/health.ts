import { tracked, type HeartbeatSpec } from "@cohost/bus";

/**
 * voice depends on the TTS container; `kokoro` flips down on a failed synthesis and back ok on the next success.
 * With the `stub` engine there is no TTS dependency (`n/a`) and the mode is `mock`.
 */
export class VoiceHealth {
  private kokoro: "ok" | "down" = "ok";
  readonly spec: HeartbeatSpec;
  constructor(engine: "kokoro" | "stub" = "kokoro") { // @spec VOICE-HLTH-001, VOICE-HLTH-003
    this.spec = engine === "stub"
      ? { service: "voice", mode: "mock", deps: () => ({ kokoro: "n/a" }) }
      : { service: "voice", mode: "live", deps: () => ({ kokoro: this.kokoro }) };
  }
  /** Wrap the synth function so its outcome drives `deps.kokoro`. */
  track(synth: (text: string) => Promise<Buffer>): (text: string) => Promise<Buffer> { // @spec VOICE-HLTH-002
    return tracked(synth, (ok) => { this.kokoro = ok ? "ok" : "down"; });
  }
}
