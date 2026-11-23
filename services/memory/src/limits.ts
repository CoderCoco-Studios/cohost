import { boundText, UNKNOWN_NAME } from "@cohost/shared/untrusted";

/** The text bounds memory applies to what a viewer or the co-host hears: the schema defaults apply to any part a config leaves out. */
export interface TextLimits {
  /** `viewer_text.max_chars`: a chat line. */
  chatMax: number;
  /** `viewer_text.max_name_chars`: a viewer or speaker name. */
  nameMax: number;
  /** `brain.input_limits.speech_max_chars`: a voice transcript. */
  speechMax: number;
}

/** The schema defaults (`viewer_text` 500 and 40, `brain.input_limits.speech_max_chars` 1000), used when no config is given. */
export const DEFAULT_TEXT_LIMITS: TextLimits = { chatMax: 500, nameMax: 40, speechMax: 1000 };

/** The part of a config these bounds are read from; a whole `Config` satisfies it. */
export interface TextLimitSource {
  viewer_text?: { max_chars?: number; max_name_chars?: number };
  brain?: { input_limits?: { speech_max_chars?: number } };
}

// @spec MEM-WRITE-008
/** A viewer or speaker name as memory keeps it: bounded, and `unknown` when nothing remains. */
export const intakeName = (raw: string, max: number): string => boundText(raw, max) || UNKNOWN_NAME;

/** The bounds a config sets, with the schema defaults for anything it leaves out. */
export function textLimits(cfg?: TextLimitSource): TextLimits {
  return {
    chatMax: cfg?.viewer_text?.max_chars ?? DEFAULT_TEXT_LIMITS.chatMax,
    nameMax: cfg?.viewer_text?.max_name_chars ?? DEFAULT_TEXT_LIMITS.nameMax,
    speechMax: cfg?.brain?.input_limits?.speech_max_chars ?? DEFAULT_TEXT_LIMITS.speechMax,
  };
}
