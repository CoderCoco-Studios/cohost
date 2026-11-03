import type { Bus, BusEvent } from "@cohost/bus";
import type { Logger } from "@cohost/config";

/** The slice of `Bus` the inject subscription needs. */
export type InjectBus = Pick<Bus, "resetGroup" | "subscribe">;

// @spec CHAT-INJ-009
/**
 * Subscribe the `chat` consumer group to `inject.request` with start mode `latest`. Resolves once
 * the group exists (`resetGroup` creates it at `$`), so the caller can signal heartbeat `ready` only
 * after the subscription is established; the read loop itself keeps running in the background.
 */
export async function subscribeInject(
  bus: InjectBus,
  handler: (ev: BusEvent<"inject.request">) => Promise<void>,
  log: Pick<Logger, "error">,
): Promise<void> {
  await bus.resetGroup("chat");
  bus.subscribe({ group: "chat", types: ["inject.request"], start: "latest" }, handler).catch((err) => {
    log.error({ err }, "inject.request subscription failed");
    process.exit(1);
  });
}
