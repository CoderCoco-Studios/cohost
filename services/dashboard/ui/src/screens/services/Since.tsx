import { useFeedClock } from "../../state/hooks";
import { agoWords, elapsed } from "./model";

/**
 * Time since `at` (the page's clock, ms), re-rendered by itself on the feed clock's one-second tick and stopped while the
 * socket is closed, so only this text changes each second and the table or card around it is left alone (DASH-UI-007).
 */
export function Since({ at, ago, words }: { at: number; ago?: boolean; /** Plain words ("14 minutes") instead of `2m 05s`; implies `ago`. */ words?: boolean }) {
  const now = useFeedClock();
  if (words) return <>{agoWords(now - at)} ago</>;
  return <>{elapsed(now - at)}{ago ? " ago" : ""}</>;
}
