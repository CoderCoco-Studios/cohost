// The WebGL context-loss reload backoff (DASH-AVP-034). Pure apart from the storage it is given.

/** The key the page keeps the last reload in, in `sessionStorage`. */
export const CONTEXT_LOSS_KEY = "cohost.avatar.contextLoss";
const FIRST_WAIT_MS = 10_000;
const CEILING_MS = 60_000;
const WINDOW_MS = 60_000;

/**
 * How long to wait before reloading after a context loss at `now`. A loss within 60 s of the last reload waits twice as
 * long as that wait, up to 60 s; otherwise 10 s. The reload is recorded at its time, the loss plus the wait. Storage that
 * throws or holds anything but a valid record gives 10 s, and nothing throws.
 */
// @spec DASH-AVP-034
export function contextLossWait(storage: Pick<Storage, "getItem" | "setItem">, now: number): number {
  let wait = FIRST_WAIT_MS;
  try {
    const raw = storage.getItem(CONTEXT_LOSS_KEY);
    const prev = raw === null ? null : (JSON.parse(raw) as unknown);
    if (typeof prev === "object" && prev !== null && !Array.isArray(prev)) {
      const { at, wait: lastWait } = prev as { at?: unknown; wait?: unknown };
      const valid = typeof at === "number" && Number.isFinite(at) && typeof lastWait === "number" && Number.isFinite(lastWait) && lastWait > 0;
      if (valid && now - at <= WINDOW_MS) wait = Math.min(CEILING_MS, lastWait * 2);
    }
  } catch {
    wait = FIRST_WAIT_MS;
  }
  try {
    storage.setItem(CONTEXT_LOSS_KEY, JSON.stringify({ at: now + wait, wait }));
  } catch {
    // A page whose storage refuses writes still waits; it just cannot double the next time.
  }
  return wait;
}
