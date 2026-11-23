import type { Config } from "@cohost/config";
import { boundText, UNKNOWN_NAME } from "@cohost/shared/untrusted";

/** The text bounds memory applies to what a viewer or the co-host hears. */
export interface TextLimits {
  /** `viewer_text.max_chars`: a chat line. */
  chatMax: number;
  /** `viewer_text.max_name_chars`: a viewer or speaker name. */
  nameMax: number;
  /** `brain.input_limits.speech_max_chars`: a voice transcript. */
  speechMax: number;
}

// @spec MEM-WRITE-008
/** A viewer or speaker name as memory keeps it: bounded, and `unknown` when nothing remains. */
export const intakeName = (raw: string, max: number): string => boundText(raw, max) || UNKNOWN_NAME;

/** The bounds the config sets. */
export function textLimits(cfg: Config): TextLimits {
  return {
    chatMax: cfg.viewer_text.max_chars,
    nameMax: cfg.viewer_text.max_name_chars,
    speechMax: cfg.brain.input_limits.speech_max_chars,
  };
}
