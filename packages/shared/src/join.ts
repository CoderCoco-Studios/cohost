export interface JoinerDeps {
  /** One join attempt; rejects on failure. */
  join: () => Promise<void>;
  /** Called after each failed attempt (1-based), before the delay. */
  onFailure: (err: unknown, attempt: number) => void;
  sleep?: (ms: number) => Promise<void>;
  /** First retry delay, ms (default 5000; doubles per consecutive failure). */
  baseMs?: number;
  /** Cap on the retry delay, ms (default 60000). */
  maxMs?: number;
  /** Ends the loop (shutdown). */
  isStopped?: () => boolean;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Join with retry: a failed attempt is reported through `onFailure` and retried after a delay
 * that doubles up to a cap, until it succeeds. Never rejects; concurrent `run()` calls share one loop.
 */
// @spec EARS-SESS-006
export function createJoiner({ join, onFailure, sleep = wait, baseMs = 5000, maxMs = 60_000, isStopped = () => false }: JoinerDeps) {
  let running: Promise<void> | undefined;
  async function loop(firstDelayMs: number): Promise<void> {
    if (firstDelayMs > 0) await sleep(firstDelayMs);
    for (let attempt = 1; !isStopped(); attempt++) {
      try {
        await join();
        return;
      } catch (err) {
        onFailure(err, attempt);
        if (isStopped()) return;
        await sleep(Math.min(maxMs, baseMs * 2 ** (attempt - 1)));
      }
    }
  }
  return {
    /** `firstDelayMs`: wait this long before the first attempt (the rejoin after a disconnect waits 5 s). */
    run: (firstDelayMs = 0): Promise<void> => (running ??= loop(firstDelayMs).finally(() => { running = undefined; })),
  };
}
