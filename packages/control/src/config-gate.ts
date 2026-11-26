import { checkConfig, type ConfigProblem } from "@cohost/config";

/**
 * The refusal of a start, restart or launch while the configuration is invalid: undefined when `check` (the config segment's
 * `checkConfig`, read fresh on every call) finds nothing, otherwise one line naming the problem count and the first problem's
 * path and pointing at the dashboard's config recovery screen. A failure `check` throws propagates.
 */
// @spec CTRL-GATE-001
export function configRefusal(check: () => readonly ConfigProblem[] = () => checkConfig()): string | undefined {
  const problems = check();
  if (problems.length === 0) return undefined;
  const first = problems[0]!;
  const n = problems.length;
  return `the config is invalid (${n} problem${n === 1 ? "" : "s"}; first: ${first.path || first.file}): fix it on the dashboard's config recovery screen (mise run dashboard), then try again`;
}
