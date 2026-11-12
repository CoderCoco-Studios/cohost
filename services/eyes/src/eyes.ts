import type { Publisher } from "@cohost/bus";
import type { Config, Logger } from "@cohost/config";
import { createChatProvider, type ChatProvider } from "@cohost/llm";

export interface EyesDeps {
  bus: Publisher;
  log: Logger;
  /** Base64 JPEG of the game source. */
  screenshot: () => Promise<string>;
  /** One line about the frame, or "SAME" / "" when nothing changed since `previous`. */
  describe: (b64: string, previous: string) => Promise<string>;
  /** Monotonic clock, ms (default `performance.now`). */
  now?: () => number;
}

// @spec EYES-OBS-007
/** obs-websocket returns a data URL; the vision model wants bare base64. */
export function stripDataUrl(imageData: string): string {
  return imageData.replace(/^data:image\/\w+;base64,/, "");
}

/** True for the error a request rejects with when its abort signal fires on a timeout. */
export const isTimeout = (err: unknown): boolean => err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");

// @spec EYES-LOOK-002, EYES-INJ-008
/**
 * A clear `SAME`: empty, or the word `SAME` in any case with nothing after it but punctuation or whitespace.
 * A description that merely starts with the word ("Same old menu screen") is a description, not a reply of no change.
 */
export const isSame = (text: string): boolean => /^(same[\s.!]*)?$/i.test(text.trim());

export type Describe = EyesDeps["describe"];

// @spec EYES-DESC-001, EYES-DESC-002, EYES-DESC-003, EYES-DESC-004, EYES-DESC-005, EYES-DESC-006
/**
 * Ask the vision model through the `ollama` provider of `@cohost/llm`, with `vision.model` and the `vision.*` options;
 * a call unanswered after `vision.timeout_ms` is aborted and throws.
 */
export function modelDescriber(cfg: Config["vision"], llm: Config["llm"], provider: ChatProvider = createChatProvider({ ...llm, provider: "ollama", model: cfg.model })): Describe {
  return async (b64, previous) => {
    // A ref'd timer, not `AbortSignal.timeout`: that one is unref'd, so on Node 22 a request that never answers lets
    // the event loop drain before the abort fires.
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(new DOMException("The operation timed out.", "TimeoutError")), cfg.timeout_ms);
    try {
      const reply = await provider.chat([
        { role: "system", content: cfg.prompt },
        { role: "user", content: previous ? `Previous description: ${previous}\nWhat is happening now?` : "What is happening now?", images: [b64] },
      ], { temperature: cfg.temperature, maxTokens: cfg.num_predict, signal: ctl.signal });
      return reply.trim().split("\n")[0] ?? "";
    } catch (err) {
      if (isTimeout(err)) throw new Error(`vision model did not answer within ${cfg.timeout_ms} ms`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };
}

// @spec EYES-STUB-001
/**
 * The describer of `vision.engine: stub`: no request. A frame without a previous description is `stub vision: <n> bytes`
 * (`n` the decoded size), and every later capture is `SAME`, so an isolated eyes with OBS reports one change.
 */
export function stubDescriber(): Describe {
  return async (b64, previous) => (previous ? "SAME" : `stub vision: ${Buffer.from(b64, "base64").length} bytes`);
}

/** The describer `vision.engine` selects. */
export function createDescriber(cfg: Config): Describe {
  return cfg.vision.engine === "stub" ? stubDescriber() : modelDescriber(cfg.vision, cfg.llm);
}

/** One look at the screen; publishes `vision.summary` only when the model saw a change. */
export class Eyes {
  private previous = "";

  constructor(private d: EyesDeps) {}

  // @spec EYES-LOOK-001, EYES-LOOK-002
  /** True when something new was published. */
  async look(): Promise<boolean> {
    const now = this.d.now ?? (() => performance.now());
    const t0 = now();
    const b64 = await this.d.screenshot();
    const text = await this.d.describe(b64, this.previous);
    if (isSame(text)) {
      this.d.log.debug({ ms: now() - t0 }, "no change");
      return false;
    }
    this.previous = text;
    await this.d.bus.publish("vision.summary", { text, changed: true });
    this.d.log.info({ ms: now() - t0, text }, "saw");
    return true;
  }
}

export interface StartDeps {
  enabled: boolean;
  connect: () => Promise<void>;
  loop: () => Promise<void>;
}

// @spec EYES-ENAB-001, EYES-ENAB-003
/** Connect to OBS and run the look loop, but only when vision is enabled; the caller reports the disabled case. */
export async function startEyes({ enabled, connect, loop }: StartDeps): Promise<boolean> {
  if (!enabled) return false;
  await connect();
  await loop();
  return true;
}
