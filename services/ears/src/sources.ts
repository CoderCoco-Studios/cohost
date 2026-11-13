/**
 * How a set of listening-source adapters stops.
 */
import type { Logger } from "@cohost/config";
import type { CaptureAdapter } from "./capture.js";

// @spec EARS-SRC-004
/** Stops every adapter, each on its own: one whose `stop()` throws is logged and does not keep the others from stopping. */
export async function stopAll(adapters: readonly CaptureAdapter[], log: Pick<Logger, "error">): Promise<void> {
  const results = await Promise.allSettled(adapters.map((a) => a.stop()));
  results.forEach((r, i) => {
    if (r.status === "rejected") log.error({ err: String(r.reason), source: adapters[i]!.name }, `ears ${adapters[i]!.name} source failed to stop`);
  });
}
