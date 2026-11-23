import { ChatError } from "@cohost/llm";
import { type HeartbeatSpec } from "@cohost/shared";

/**
 * A describe failure that concerns one frame, not the provider (EYES-PROV-007): a 400 or 422 from the provider, or a
 * TypeError from the model layer for image data in no supported format (LLM-VIS-005). Every other failure is an outage.
 */
// @spec EYES-PROV-006, EYES-PROV-007
export const isFrameFault = (err: unknown): boolean =>
  err instanceof TypeError || (err instanceof ChatError && err.kind === "http" && (err.status === 400 || err.status === 422));

export interface EyesHealthOptions {
  /** The heartbeat detail: the destination, as `describerLabel` names it. */
  label?: string;
  /** A configuration gap: `vision` starts `down` (EYES-GAP-002, EYES-GAP-003). */
  gap?: string;
}

// @spec EYES-HEALTH-001, EYES-HEALTH-002, EYES-HEALTH-003, EYES-HEALTH-004, EYES-STUB-002
/**
 * eyes: `off` (deps n/a) when vision is disabled; otherwise obs follows the websocket and `vision` the describe calls.
 * The stub provider reports mode `mock` and `vision` `n/a`.
 */
export class EyesHealth {
  private vision: "ok" | "down";
  readonly spec: HeartbeatSpec;

  constructor(private enabled: boolean, private obsConnected: () => boolean, private provider: string = "ollama", opts: EyesHealthOptions = {}) {
    this.vision = opts.gap ? "down" : "ok";
    this.spec = {
      service: "eyes",
      mode: () => (this.enabled ? (this.provider === "stub" ? "mock" : "live") : "off"),
      deps: () => (this.enabled
        ? { obs: this.obsConnected() ? "ok" : "down", vision: this.provider === "stub" ? "n/a" : this.vision }
        : { obs: "n/a", vision: "n/a" }),
      ...(opts.label ? { detail: opts.label } : {}),
    };
  }

  // @spec EYES-HEALTH-003, EYES-PROV-006, EYES-PROV-007
  /** Wrap a describe call: success sets `vision` ok, an outage-class failure sets it down; a frame fault leaves it as it was. */
  track(describe: (b64: string, previous: string) => Promise<string>) {
    return async (b64: string, previous: string): Promise<string> => {
      try {
        const text = await describe(b64, previous);
        this.vision = "ok";
        return text;
      } catch (err) {
        if (!isFrameFault(err)) this.vision = "down";
        throw err;
      }
    };
  }
}
