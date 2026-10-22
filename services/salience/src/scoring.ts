import { Module, clamp, isNum, type ModuleImpl } from "@cohost/modules";
import type { Config, Logger } from "@cohost/config";
import type { ContextEvent } from "@cohost/working-memory";

/** What the scorer sees: the unseen events, flattened, plus the current mood. */
export interface ScoreInput {
  events: { kind: "chat" | "speech" | "vision"; who?: string; text: string; mention: boolean; isMod: boolean; isSub: boolean; changed: boolean }[];
  arousal: number;
}
/** One 0..1 number per event, same order. */
export interface ScoreOutput { scores: number[] }

export function toScoreInput(unseen: ContextEvent[], arousal: number): ScoreInput {
  const events: ScoreInput["events"] = [];
  for (const e of unseen) {
    if (e.kind === "chat") events.push({ kind: "chat", who: e.user, text: e.text, mention: e.mention, isMod: e.isMod, isSub: e.isSub, changed: false });
    else if (e.kind === "speech") events.push({ kind: "speech", who: e.speaker, text: e.text, mention: false, isMod: false, isSub: false, changed: false });
    else if (e.kind === "vision") events.push({ kind: "vision", text: e.text, mention: false, isMod: false, isSub: false, changed: e.changed });
  }
  return { arousal, events };
}

/** The built-in weights. Also the fallback for the llm / http kinds. */
export function scoreRules(input: ScoreInput, replyOnMention: boolean): ScoreOutput {
  return {
    scores: input.events.map((e) => {
      if (e.kind === "speech") return 0.9;                   // the streamer talked to it (or near it)
      if (e.kind === "chat") {
        if (e.mention && replyOnMention) return 1.0;
        if (e.text.includes("?")) return 0.55;
        if (e.isMod || e.isSub) return 0.35;
        return 0.15;
      }
      return e.changed ? 0.3 : 0;                            // vision
    }),
  };
}

function validate(raw: unknown, input: ScoreInput): ScoreOutput | undefined {
  const scores = (raw as { scores?: unknown })?.scores;
  if (!Array.isArray(scores) || scores.length !== input.events.length || !scores.every(isNum)) return undefined;
  return { scores: scores.map((s) => clamp(s, 0, 1)) };
}

export function createScorer(cfg: Config, log: Logger): Module<ScoreInput, ScoreOutput> {
  const impl: ModuleImpl<ScoreInput, ScoreOutput> = {
    rules: (i) => scoreRules(i, cfg.brain.salience.reply_on_mention),
    llm: {
      system:
        `You decide how much each event deserves a reaction from ${cfg.cohost.name}, an AI co-host on ${cfg.cohost.streamer}'s stream. ` +
        `Score each event 0..1: 1.0 = must respond (addressed directly, big moment), 0.5 = worth a comment, 0.1 = background noise. ` +
        `Reply with JSON only: {"scores":[...]} with exactly one number per event, in order.`,
      user: (i) =>
        `Current arousal: ${i.arousal.toFixed(2)}\n` +
        i.events.map((e, n) => `${n + 1}. [${e.kind}${e.mention ? ", mentions co-host" : ""}${e.isMod ? ", mod" : ""}] ${e.who ? e.who + ": " : ""}${e.text}`).join("\n"),
      maxTokens: 120,
      validate,
    },
    http: { validate },
  };
  return new Module("salience.scorer", cfg.brain.salience.module, cfg.llm, impl, log);
}
