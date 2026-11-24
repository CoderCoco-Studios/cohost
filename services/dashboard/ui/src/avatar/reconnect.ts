// The socket's reconnect schedule (DASH-AVP-033). Pure.

const FIRST_MS = 1000;
const CEILING_MS = 10_000;
/** A connection open at least this long resets the schedule. */
const STABLE_MS = 10_000;

export interface Reconnect {
  /**
   * Records a close and returns the delay before the next attempt. `openMs` is how long the connection was open, or null
   * for a refused upgrade (never open). A connection open for 10 s resets the count first; each close then doubles the
   * delay from 1 s, up to 10 s.
   */
  onClose(openMs: number | null): number;
}

// @spec DASH-AVP-033
export function createReconnect(): Reconnect {
  let failures = 0;
  return {
    onClose(openMs) {
      if (openMs !== null && openMs >= STABLE_MS) failures = 0;
      failures += 1;
      return Math.min(CEILING_MS, FIRST_MS * 2 ** (failures - 1));
    },
  };
}
