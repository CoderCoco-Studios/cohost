import { Module, type ModuleImpl } from "@cohost/modules";
import { EMOTIONS, type Config, type Emotion, type Logger } from "@cohost/config";

/** A reply the cortex is about to say, before it goes to the voice. */
export interface CriticInput {
  text: string;
  emotion: Emotion;
  reason: string;
  /** The recent transcript the reply was written against. */
  transcript: string;
}
/** ok=false drops the line. text/emotion, if present, replace the originals. */
export interface CriticOutput { ok: boolean; text?: string; emotion?: Emotion; note?: string }

function validate(raw: unknown): CriticOutput | undefined {
  const r = raw as { ok?: unknown; text?: unknown; emotion?: unknown; note?: unknown } | undefined;
  if (!r || typeof r.ok !== "boolean") return undefined;
  const out: CriticOutput = { ok: r.ok };
  if (typeof r.text === "string" && r.text.trim()) out.text = r.text.trim();
  if (typeof r.emotion === "string" && (EMOTIONS as readonly string[]).includes(r.emotion)) out.emotion = r.emotion as Emotion;
  if (typeof r.note === "string") out.note = r.note;
  return out;
}

/**
 * Inhibition. The built-in rule is pass-through; an llm or http critic can
 * veto or rewrite a line before anyone hears it.
 */
export function createCritic(cfg: Config, log: Logger): Module<CriticInput, CriticOutput> {
  const impl: ModuleImpl<CriticInput, CriticOutput> = {
    rules: () => ({ ok: true }),
    llm: {
      system:
        `You are the inner editor of ${cfg.cohost.name}, an AI co-host on ${cfg.cohost.streamer}'s live stream. ` +
        `You see a line ${cfg.cohost.name} is about to say out loud. Block it if it is hateful, doxxes anyone, breaks character, ` +
        `narrates instead of speaking, repeats something said moments ago, or is longer than two sentences. ` +
        `If a small edit fixes it, return the fixed line. Reply with JSON only: {"ok":true} or {"ok":true,"text":"fixed line"} or {"ok":false,"note":"why"}.`,
      user: (i) => `## Recent transcript\n${i.transcript || "(quiet)"}\n\n## About to say (${i.emotion}, because: ${i.reason})\n${i.text}`,
      maxTokens: 160,
      validate,
    },
    http: { validate },
  };
  return new Module("cortex.critic", cfg.brain.cortex.critic, cfg.llm, impl, log);
}
