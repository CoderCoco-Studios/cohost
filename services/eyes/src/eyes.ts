import type { Publisher } from "@cohost/bus";
import type { Config, Logger } from "@cohost/config";
import { createChatProvider, notConfiguredReason, type ChatProvider } from "@cohost/llm";
import { egressDestinations } from "@cohost/config";

export interface EyesDeps {
  bus: Publisher;
  log: Logger;
  /** Base64 JPEG of the game source. */
  screenshot: () => Promise<string>;
  /** One line about the frame, or "SAME" / "" when nothing changed since `previous`. */
  describe: (b64: string, previous: string) => Promise<string>;
  /** Monotonic clock, ms (default `performance.now`). */
  now?: () => number;
  /** Epoch clock, ms, for the `vision.summary` stamps (default `Date.now`). */
  wallNow?: () => number;
}

// @spec EYES-OBS-007
/** obs-websocket returns a data URL; the vision model wants bare base64. */
export function stripDataUrl(imageData: string): string {
  return imageData.replace(/^data:image\/\w+;base64,/, "");
}

// @spec EYES-LOOK-002, EYES-INJ-008
/**
 * A clear `SAME`: empty, or the word `SAME` in any case with nothing after it but punctuation or whitespace.
 * A description that merely starts with the word ("Same old menu screen") is a description, not a reply of no change.
 */
export const isSame = (text: string): boolean => /^(same[\s.!]*)?$/i.test(text.trim());

export type Describe = EyesDeps["describe"];

/** The chat provider `vision.provider` names; the stub has none, and `createDescriber` never asks for one. */
function chatOf(cfg: Config["vision"], llm: Config["llm"]): ChatProvider {
  if (cfg.provider === "stub") throw new Error("the stub provider has no chat provider: createDescriber selects stubDescriber");
  return createChatProvider({ ...llm, provider: cfg.provider, model: cfg.model });
}

// @spec EYES-DESC-001, EYES-DESC-002, EYES-DESC-003, EYES-DESC-004, EYES-DESC-005, EYES-DESC-006
/**
 * Ask the vision model through the chat provider `vision.provider` names, with `vision.model` and the `vision.*` options.
 * The describer owns the `vision.timeout_ms` timer: a call unanswered after that long rejects and the request is aborted,
 * even when the provider ignores the signal (the race below), so no provider can stall the look loop.
 */
export function modelDescriber(cfg: Config["vision"], llm: Config["llm"], provider?: ChatProvider): Describe {
  const chat = provider ?? chatOf(cfg, llm);
  return async (b64, previous) => {
    // A ref'd timer, not `AbortSignal.timeout`: that one is unref'd, so on Node 22 a request that never answers lets
    // the event loop drain before the abort fires.
    const ctl = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(`vision model did not answer within ${cfg.timeout_ms} ms`);
        ctl.abort(err);
        reject(err);
      }, cfg.timeout_ms);
    });
    try {
      const reply = await Promise.race([
        chat.chat([
          { role: "system", content: cfg.prompt },
          { role: "user", content: previous ? `Previous description: ${previous}\nWhat is happening now?` : "What is happening now?", images: [b64] },
        ], { temperature: cfg.temperature, maxTokens: cfg.num_predict, signal: ctl.signal }),
        expired,
      ]);
      return reply.trim().split("\n")[0] ?? "";
    } finally {
      clearTimeout(timer);
    }
  };
}

// @spec EYES-STUB-001
/**
 * The describer of `vision.provider: stub`: no request. A frame without a previous description is `stub vision: <n> bytes`
 * (`n` the decoded size), and every later capture is `SAME`, so an isolated eyes with OBS reports one change.
 */
export function stubDescriber(): Describe {
  return async (b64, previous) => (previous ? "SAME" : `stub vision: ${Buffer.from(b64, "base64").length} bytes`);
}

/** The provider a start builds, or the gap that keeps it from describing; undefined for the stub, which builds none. */
export type VisionBuild = { provider: ChatProvider } | { gap: string };

// @spec EYES-GAP-001, EYES-GAP-003, EYES-GAP-006
/**
 * Build the chat provider `vision.provider` names, or the configuration gap that keeps it from describing: a blank `vision.model`,
 * a hosted provider without its credentials, or a provider the model layer refuses to construct (a bedrock key pair only partly
 * set, LLM-CLAUDE-016). A gap is not a load failure: the service stays up and reports the reason. Built once per start.
 */
export function buildVisionProvider(cfg: Config): VisionBuild | undefined {
  const { provider, model } = cfg.vision;
  if (provider === "stub") return undefined;
  if (!model) return { gap: "vision.model is not set" };
  try {
    const chat = createChatProvider({ ...cfg.llm, provider, model });
    const missing = provider === "anthropic" || provider === "bedrock" ? notConfiguredReason(cfg.llm, provider) : undefined;
    return missing ? { gap: missing } : { provider: chat };
  } catch (err) {
    return { gap: err instanceof Error ? err.message : String(err) };
  }
}

/** The describer `vision.provider` selects. A stub is `stubDescriber`; a gap describes by failing at once with its reason (EYES-GAP-001, EYES-GAP-004). */
// @spec EYES-PROV-001, EYES-PROV-002, EYES-PROV-003, EYES-GAP-001, EYES-GAP-003, EYES-GAP-004
export function createDescriber(cfg: Config, built: VisionBuild | undefined = buildVisionProvider(cfg)): Describe {
  if (!built) return stubDescriber();
  if ("gap" in built) {
    const reason = built.gap;
    return async () => { throw new Error(reason); };
  }
  return modelDescriber(cfg.vision, cfg.llm, built.provider);
}

// @spec EYES-EGR-001, EYES-EGR-002, EYES-EGR-003, EYES-EGR-004, EYES-STUB-002
/** The heartbeat detail naming the frames' destination: `openai at api.openai.com`, or the provider alone for a hosted one; undefined for the stub. */
export function describerLabel(cfg: Config): string | undefined {
  const dest = egressDestinations(cfg).find((e) => e.service === "eyes");
  if (!dest) return undefined;
  return dest.host ? `${dest.engine} at ${dest.host}` : dest.engine;
}

/** The configuration gap of a build, or undefined when the describer can describe. */
export function gapOf(built: VisionBuild | undefined): string | undefined {
  return built && "gap" in built ? built.gap : undefined;
}

/** One look at the screen; publishes `vision.summary` only when the model saw a change. */
export class Eyes {
  private previous = "";

  constructor(private d: EyesDeps) {}

  // @spec EYES-LOOK-001, EYES-LOOK-002, EYES-LOOK-006, EYES-LOOK-007
  /** True when something new was published. */
  async look(): Promise<boolean> {
    const now = this.d.now ?? (() => performance.now());
    const wall = this.d.wallNow ?? Date.now;
    const t0 = now();
    const b64 = await this.d.screenshot();
    const capturedAt = wall();
    const d0 = now();
    const text = await this.d.describe(b64, this.previous);
    const describedAt = wall();
    const describeMs = now() - d0;
    if (isSame(text)) {
      this.d.log.debug({ ms: now() - t0, describeMs }, "no change");
      return false;
    }
    this.previous = text;
    await this.d.bus.publish("vision.summary", { text, changed: true, timing: { capturedAt, describedAt } });
    this.d.log.info({ ms: now() - t0, describeMs, text }, "saw");
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
