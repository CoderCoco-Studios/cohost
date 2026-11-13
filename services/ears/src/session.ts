import type { Bus, BusEvent } from "@cohost/bus";
import type { Logger } from "@cohost/config";

export type EarsEventType = "inject.request";

/** The one type the `ears` loop reads, in every plan; never `voice.*` or `control` (EARS-START-003, EARS-HEAR-009). */
// @spec EARS-START-003, EARS-HEAR-009
export const EARS_LOOP_TYPES = ["inject.request"] as const satisfies readonly EarsEventType[];

export interface EarsHandlerDeps {
  onInject: (ev: BusEvent<"inject.request">) => void | Promise<void>;
}

/** The one `ears` loop's handler: `inject.request` goes to the injection handler; anything else is ignored. */
// @spec EARS-START-003, EARS-INJ-009
export function createEarsHandler({ onInject }: EarsHandlerDeps) {
  return async (ev: BusEvent): Promise<void> => {
    if (ev.type === "inject.request") await onInject(ev as BusEvent<"inject.request">);
  };
}

/** The slice of `Bus` the ears subscription needs. */
export type EarsBus = Pick<Bus, "resetGroup" | "subscribe">;

/**
 * Subscribe the `ears` consumer group with start mode `latest`. Resolves once the group exists
 * (`resetGroup` creates it at `$`), so the caller can signal `ready` only after the subscription
 * is established; the read loop itself keeps running in the background.
 */
// @spec EARS-START-006
export async function subscribeEars(
  bus: EarsBus,
  types: readonly EarsEventType[],
  handler: (ev: BusEvent) => Promise<void>,
  log: Pick<Logger, "error">,
): Promise<void> {
  await bus.resetGroup("ears");
  bus.subscribe({ group: "ears", types, start: "latest" }, handler).catch((err) => {
    log.error({ err }, "ears subscription failed");
    process.exit(1);
  });
}
