import type { Config, Emotion } from "@cohost/config";

type Rule = Config["brain"]["salience"]["reflexes"][number];
export type Sense = Rule["on"][number];

export interface ReflexHit { text: string; emotion: Emotion; gesture?: string; rule: string }

/**
 * The amygdala's "low road": pattern → canned reaction, no LLM, fires the
 * instant the event lands. Each rule has its own cooldown so a spammy chat
 * can't turn a reflex into a tic.
 */
export class Reflexes {
  private rules: { re: RegExp; rule: Rule; lastFired: number }[];

  constructor(rules: Rule[]) {
    this.rules = rules.map((rule) => ({ re: new RegExp(rule.match, "i"), rule, lastFired: 0 }));
  }

  get size(): number { return this.rules.length; }

  test(sense: Sense, text: string, now = Date.now()): ReflexHit | undefined {
    for (const r of this.rules) {
      if (!r.rule.on.includes(sense)) continue;
      if (now - r.lastFired < r.rule.cooldown_ms) continue;
      if (!r.re.test(text)) continue;
      r.lastFired = now;
      const say = r.rule.say[Math.floor(Math.random() * r.rule.say.length)]!;
      return { text: say, emotion: r.rule.emotion, gesture: r.rule.gesture, rule: r.rule.match };
    }
    return undefined;
  }
}
