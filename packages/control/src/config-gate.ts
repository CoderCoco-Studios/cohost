import { checkStore } from "@cohost/store";

/** One problem that stops a start: a stored setting's path, or a cause of the store or the key (settings-store STORE-RCV-001). */
export interface GateProblem { path?: string; message: string; cause?: string; file?: string }

/**
 * The refusal of a start, restart, launch or delivery while the settings store cannot be used: undefined when `check` (the
 * store's `checkStore`, read fresh on every call) finds nothing, otherwise one line naming the problem count and the first
 * problem (its path, or for a store or key problem its cause) and pointing at the dashboard's recovery screen and
 * `mise run config:check`. A failure `check` throws propagates.
 */
// @spec CTRL-GATE-001
export async function configRefusal(check: () => readonly GateProblem[] | Promise<readonly GateProblem[]> = () => checkStore()): Promise<string | undefined> {
  const problems = await check();
  if (problems.length === 0) return undefined;
  const first = problems[0]!;
  const n = problems.length;
  const what = first.path || first.cause || first.file || first.message;
  return `the settings store cannot be used (${n} problem${n === 1 ? "" : "s"}; first: ${what}): fix it on the dashboard's recovery screen (mise run dashboard) or with mise run config:check, then try again`;
}
