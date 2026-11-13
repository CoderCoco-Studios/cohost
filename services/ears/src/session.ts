import type { Bus, BusEvent } from "@cohost/bus";
import type { Logger } from "@cohost/config";

export type EarsEventType = "inject.request" | "voice.playing" | "voice.done";

/** The type the `ears` loop reads in every plan, with `voice.playing` and `voice.done` added only where a source is echo-gated (EARS_ECHO_LOOP_TYPES); never `control` (EARS-START-003, EARS-HEAR-009). */
// @spec EARS-START-003, EARS-HEAR-009
export const EARS_LOOP_TYPES = ["inject.request"] as const satisfies readonly EarsEventType[];

/** The types the loop reads where an enabled source is gated by the echo gate (EARS-ECHO-001). */
// @spec EARS-ECHO-001
export const EARS_ECHO_LOOP_TYPES = ["inject.request", "voice.playing", "voice.done"] as const satisfies readonly EarsEventType[];

export interface EarsHandlerDeps {
  onInject: (ev: BusEvent<"inject.request">) => void | Promise<void>;
  /** The echo gate's input; absent where the loop reads `inject.request` only. */
  onVoice?: (ev: BusEvent<"voice.playing" | "voice.done">) => void;
}

/** The one `ears` loop's handler: `inject.request` goes to the injection handler; anything else is ignored. */
// @spec EARS-START-003, EARS-INJ-009
export function createEarsHandler({ onInject, onVoice }: EarsHandlerDeps) {
  return async (ev: BusEvent): Promise<void> => {
    if (ev.type === "inject.request") await onInject(ev as BusEvent<"inject.request">);
    else if (onVoice && (ev.type === "voice.playing" || ev.type === "voice.done")) onVoice(ev as BusEvent<"voice.playing" | "voice.done">);
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
