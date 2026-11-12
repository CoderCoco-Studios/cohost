/**
 * The adapters of the enabled listening sources: what a source that is not served by a capture listener looks like, and how
 * a set of adapters stops.
 */
import type { Logger } from "@cohost/config";
import type { CaptureAdapter } from "./capture.js";

// @spec EARS-SRC-004, EARS-SRC-005
/**
 * A connector source with no connector behind it: starts at once and stays `down` (the detail the heartbeat shows is
 * `<tag> connector not connected`). It never makes a source up by itself and never stops the other sources.
 */
export function createAbsentConnector(tag: string): CaptureAdapter {
  return { name: tag, start: async () => {}, stop: async () => {}, status: () => "down" };
}

// @spec EARS-SRC-004
/** Stops every adapter, each on its own: one whose `stop()` throws is logged and does not keep the others from stopping. */
export async function stopAll(adapters: readonly CaptureAdapter[], log: Pick<Logger, "error">): Promise<void> {
  const results = await Promise.allSettled(adapters.map((a) => a.stop()));
  results.forEach((r, i) => {
    if (r.status === "rejected") log.error({ err: String(r.reason), source: adapters[i]!.name }, `ears ${adapters[i]!.name} source failed to stop`);
  });
}
