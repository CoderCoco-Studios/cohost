import { useFeed } from "../state/hooks";

const time = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });

/**
 * The connection banner: while `/ws` is closed it says live updates stopped, at what time, and when the next attempt is
 * (every 2 s); on reconnect it disappears (DASH-UI-001).
 */
// @spec DASH-UI-001
export function ConnectionBanner() {
  const status = useFeed((f) => f.status), stoppedAt = useFeed((f) => f.stoppedAt), nextAttemptAt = useFeed((f) => f.nextAttemptAt);
  if (stoppedAt === undefined) return null;
  return (
    <div className="note note-warn connection-banner" role="status" aria-label="Connection">
      <strong>{`Live updates stopped at ${time(stoppedAt)}.`}</strong>{" "}
      {status === "closed" && nextAttemptAt !== undefined ? `The dashboard is trying again at ${time(nextAttemptAt)}.` : "Reconnecting…"}
    </div>
  );
}

/**
 * Props for a region that shows live data (the feed, the services list, the stack card): while the socket is closed it is
 * `aria-busy` and carries the class `stale`, which the stylesheet dims. Spread them: `<section {...useStale()}>` (DASH-UI-001).
 */
// @spec DASH-UI-001
export function useStale(): { className?: string; "aria-busy"?: true } {
  const closed = useFeed((f) => f.stoppedAt !== undefined);
  return closed ? { className: "stale", "aria-busy": true } : {};
}
