import { useFeedClock } from "../../state/hooks";
import { elapsed } from "./model";

/**
 * Time since `at` (the page's clock, ms), re-rendered by itself on the feed clock's one-second tick and stopped while the
 * socket is closed, so only this text changes each second and the table or card around it is left alone (DASH-UI-007).
 */
export function Since({ at, ago }: { at: number; ago?: boolean }) {
  const now = useFeedClock();
  return <>{elapsed(now - at)}{ago ? " ago" : ""}</>;
}
