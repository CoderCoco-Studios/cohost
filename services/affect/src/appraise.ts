import { Module, clamp, isNum, type ModuleImpl } from "@cohost/modules";
import type { Config, Logger } from "@cohost/config";

/** One line of chat or voice, as the appraiser sees it. */
export interface AppraiseInput {
  source: "chat" | "speech";
  who: string;
  text: string;
  mention: boolean;
  /** Current mood, so a module can be context-sensitive. */
  valence: number;
  arousal: number;
}
/** How much to move the mood. Both are deltas, clamped to +-0.5. */
export interface AppraiseOutput { valence_delta: number; arousal_delta: number }

const POSITIVE = /\b(lol|lmao|haha+|pog(gers|champ)?|gg|w|love|nice|let'?s go|hype|based|goat|clutch|ez|amazing|cute|wholesome)\b|[😂🤣❤️🔥]/i;
const NEGATIVE = /\b(boo|l|ratio|trash|cringe|hate|boring|mald|rip|f|oof|unlucky|scam|bad|worst|ugh)\b|[😡💀👎]/i;

/** The built-in word lists. Also the fallback for the llm / http kinds. */
export function appraiseRules(i: AppraiseInput): AppraiseOutput {
  let dv = 0;
  let da = i.source === "speech" ? 0.15 : 0.03;
  if (i.mention) da += 0.2;
  if (POSITIVE.test(i.text)) { dv += 0.12; da += 0.05; }
  if (NEGATIVE.test(i.text)) { dv -= 0.15; da += 0.08; }
  if (/!{2,}|[A-Z]{5,}/.test(i.text)) da += 0.05;
  if (i.text.includes("?")) da += 0.03;
  return { valence_delta: dv, arousal_delta: da };
}

function validate(raw: unknown): AppraiseOutput | undefined {
  const r = raw as { valence_delta?: unknown; arousal_delta?: unknown } | undefined;
  if (!r || !isNum(r.valence_delta) || !isNum(r.arousal_delta)) return undefined;
  return { valence_delta: clamp(r.valence_delta, -0.5, 0.5), arousal_delta: clamp(r.arousal_delta, -0.5, 0.5) };
}

export function createAppraiser(cfg: Config, log: Logger): Module<AppraiseInput, AppraiseOutput> {
  const impl: ModuleImpl<AppraiseInput, AppraiseOutput> = {
    rules: appraiseRules,
    llm: {
      system:
        `You are the emotional appraisal of ${cfg.cohost.name}, an AI co-host on ${cfg.cohost.streamer}'s stream. ` +
        `Given one line someone said, decide how it should move ${cfg.cohost.name}'s mood. ` +
        `valence_delta: -0.3 (hurtful/sad) .. 0.3 (delightful). arousal_delta: 0 (dull) .. 0.3 (exciting, addressed directly). ` +
        `Reply with JSON only: {"valence_delta":n,"arousal_delta":n}.`,
      user: (i) => `Mood now: valence ${i.valence.toFixed(2)}, arousal ${i.arousal.toFixed(2)}\n[${i.source}${i.mention ? ", mentions co-host" : ""}] ${i.who}: ${i.text}`,
      maxTokens: 60,
      validate,
    },
    http: { validate },
  };
  return new Module("affect.appraiser", cfg.brain.affect.module, cfg.llm, impl, log);
}
