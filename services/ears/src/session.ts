import type { Bus, BusEvent } from "@cohost/bus";
import type { Config, Logger } from "@cohost/config";

/** The guild and voice channel ears joins, from `ears.discord.guild_id` / `voice_channel_id`. */
// @spec EARS-SESS-007
export function voiceTarget(cfg: Config["ears"]["discord"]): { guildId: string; channelId: string } {
  if (!cfg.guild_id) throw new Error("ears.discord.guild_id is not set");
  if (!cfg.voice_channel_id) throw new Error("ears.discord.voice_channel_id is not set");
  return { guildId: cfg.guild_id, channelId: cfg.voice_channel_id };
}

export type EarsEventType = "inject.request";

/** The one type the `ears` loop reads, in every plan; never `voice.*` or `control` (EARS-START-003, EARS-HEAR-009). */
// @spec EARS-START-003, EARS-HEAR-009
export const EARS_LOOP_TYPES = ["inject.request"] as const satisfies readonly EarsEventType[];

/** How ears joins the voice channel: self-muted (it never speaks), not self-deafened (it listens). */
// @spec EARS-SESS-002, EARS-SESS-004
export const EARS_JOIN_OPTIONS = { selfMute: true, selfDeaf: false } as const;

export interface EarsHandlerDeps {
  onInject: (ev: BusEvent<"inject.request">) => void | Promise<void>;
}

/** The one `ears` loop's handler: `inject.request` goes to the injection handler; anything else is ignored. */
// @spec EARS-INJ-007, EARS-START-003
export function createEarsHandler({ onInject }: EarsHandlerDeps) {
  return async (ev: BusEvent): Promise<void> => {
    if (ev.type === "inject.request") await onInject(ev as BusEvent<"inject.request">);
  };
}

/** The slice of discord.js' `client.users` that `isHumanSpeaker` needs. */
export interface UserLookup {
  cache: { get(id: string): { bot: boolean } | undefined };
  fetch(id: string): Promise<{ bot: boolean }>;
}

/**
 * Whether a speaker may be captured: only a non-bot account. The `bot` flag comes from the cache, else from a fetch
 * before capture; a speaker whose account cannot be fetched is not captured.
 */
// @spec EARS-HEAR-001
export async function isHumanSpeaker(userId: string, users: UserLookup): Promise<boolean> {
  try {
    const user = users.cache.get(userId) ?? (await users.fetch(userId));
    return !user.bot;
  } catch {
    return false;
  }
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
