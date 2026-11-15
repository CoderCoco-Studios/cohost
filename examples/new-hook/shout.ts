/**
 * A new brain hook, built the way the region hooks are: "is this line shouting?".
 *
 * A hook is a `Module<I, O>` from @cohost/modules: a `rules` function that always answers (it is also the
 * fallback), and optional `llm` and `http` implementations that each validate what came back. The
 * config's `kind` picks which one runs; an unusable reply from `llm` or `http` makes `run` return
 * the rules' answer instead.
 */

// The workspace packages are imported by path here because this folder is not a workspace package; inside a
// service folder they are imported as "@cohost/modules" and "@cohost/config".
import { Module, type ModuleConfig, type ModuleImpl, type ModuleOptions } from "../../packages/modules/dist/index.js";
import type { Config, Logger } from "../../packages/config/dist/index.js";

// #region types
/** What the hook is asked. */
export interface ShoutInput { text: string }
/** What it answers. */
export interface ShoutOutput { shouting: boolean }
// #endregion types

// #region rules
/** Shouting: at least three letters that have a case, and none of them lower case. Never throws. */
export function shoutRules(input: ShoutInput): ShoutOutput { // @spec HOOK-EX-018
  const letters = input.text.match(/\p{Lu}|\p{Ll}/gu) ?? [];
  return { shouting: letters.length >= 3 && !letters.some((c) => /\p{Ll}/u.test(c)) };
}
// #endregion rules

// #region validate
/** An `http` reply or the JSON an `llm` reply holds: an object with a boolean `shouting`, anything else unusable. */
function validate(raw: unknown): ShoutOutput | undefined { // @spec HOOK-EX-019
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const shouting = (raw as { shouting?: unknown }).shouting;
  return typeof shouting === "boolean" ? { shouting } : undefined;
}
// #endregion validate

// #region create
export function createShoutHook( // @spec HOOK-EX-017
  hook: ModuleConfig,
  llm: Config["llm"],
  log: Logger,
  opts?: ModuleOptions,
): Module<ShoutInput, ShoutOutput> {
  const impl: ModuleImpl<ShoutInput, ShoutOutput> = {
    rules: shoutRules,
    llm: {
      system: 'You decide whether a line of chat is shouting (written in capital letters). Reply with JSON only: {"shouting": true} or {"shouting": false}.',
      user: (i) => i.text,
      maxTokens: 30,
      validate,
    },
    http: { validate },
  };
  return new Module("shout", hook, llm, impl, log, opts);
}
// #endregion create
