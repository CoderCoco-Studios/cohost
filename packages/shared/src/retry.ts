export interface RetryOptions {
  /** Delay after the first failure, ms. */
  baseMs: number;
  /** Cap on the delay, ms. */
  maxMs: number;
  /** Delay multiplier per consecutive failure (default 2; 1 gives a fixed delay). */
  factor?: number;
  /** Wait this long before the first attempt (default 0: none). */
  firstDelayMs?: number;
  /** Ends the loop (shutdown): checked before every attempt and after every wait. */
  isStopped?: () => boolean;
  /** Called with each failure (1-based count) and the delay about to be waited; a throw is ignored. */
  onFailure?: (err: unknown, attempt: number, delayMs: number) => void;
  /** An error retrying cannot fix: it rejects at once, with no `onFailure` and no wait. */
  isFatal?: (err: unknown) => boolean;
  /** Wait for `ms` (default a timer); a test passes a fake. */
  sleep?: (ms: number) => Promise<void>;
}

const timerSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Call `attempt()` until it resolves and return its value. After the n-th consecutive failure it reports
 * `onFailure` and waits `min(maxMs, baseMs * factor^(n-1))`. It does not reject for an ordinary failure:
 * a stop resolves `undefined` at the next check.
 */
// @spec SHARED-RETRY-001, SHARED-RETRY-002, SHARED-RETRY-003, SHARED-RETRY-004, SHARED-RETRY-005, SHARED-RETRY-007
export async function retryWithBackoff<T>(attempt: () => Promise<T>, opts: RetryOptions): Promise<T | undefined> {
  const { baseMs, maxMs, factor = 2, firstDelayMs = 0, isStopped = () => false, onFailure, isFatal, sleep = timerSleep } = opts;
  if (firstDelayMs > 0) await sleep(firstDelayMs);
  for (let n = 1; ; n++) {
    if (isStopped()) return undefined;
    try {
      return await attempt();
    } catch (err) {
      if (isFatal?.(err)) throw err;
      const delayMs = Math.min(maxMs, baseMs * factor ** Math.min(n - 1, 60));
      try { onFailure?.(err, n, delayMs); } catch { /* a reporting callback must not stop the retry */ }
      if (isStopped()) return undefined;
      await sleep(delayMs);
    }
  }
}

/** Wrap an async function so concurrent calls share one running call; the next call after it settles starts a new one. */
// @spec SHARED-RETRY-006
export function singleFlight<A extends unknown[], T>(fn: (...args: A) => Promise<T>): (...args: A) => Promise<T> {
  let running: Promise<T> | undefined;
  return (...args) => (running ??= fn(...args).finally(() => { running = undefined; }));
}
