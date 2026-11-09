import type { Bus, BusEvent } from "@cohost/bus";
import type { Config, Logger } from "@cohost/config";

/** The guild and voice channel ears joins, from `ears.discord.guild_id` / `voice_channel_id`. */
// @spec EARS-SESS-007
export function voiceTarget(cfg: Config["ears"]["discord"]): { guildId: string; channelId: string } {
  if (!cfg.guild_id) throw new Error("ears.discord.guild_id is not set");
  if (!cfg.voice_channel_id) throw new Error("ears.discord.voice_channel_id is not set");
  return { guildId: cfg.guild_id, channelId: cfg.voice_channel_id };
}

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

export type EarsEventType = "voice.utterance" | "voice.playing" | "inject.request";

/** The types the one `ears` loop reads in the `discord` plan (EARS-PLAY-001, EARS-FALL-010). */
export const DISCORD_LOOP_TYPES = ["voice.utterance", "voice.playing", "inject.request"] as const satisfies readonly EarsEventType[];

export interface EarsHandlerDeps {
  onInject: (ev: BusEvent<"inject.request">) => Promise<void>;
  playback: { enqueue(id: string, url: string): Promise<void> };
  isVoiceReady: () => boolean;
  log: Pick<Logger, "debug">;
  /** Which utterance ids a real sink other than `discord` claimed (the fallback line's memory, EARS-FALL-010). */
  claims?: { seen(id: string): void; claim(id: string, sink: string): void };
}

/**
 * The one `ears` loop's handler: `inject.request` always goes to the injection handler; a
 * `voice.utterance` is queued for playback only while the voice connection is ready, and is
 * skipped otherwise (no `voice.failed`, no fallback) so voice's virtual sink covers it. A `voice.playing` only
 * feeds the fallback line's claim memory.
 */
// @spec EARS-INJ-007, EARS-FALL-010, EARS-FALL-013
export function createEarsHandler({ onInject, playback, isVoiceReady, log, claims }: EarsHandlerDeps) {
  return async (ev: BusEvent): Promise<void> => {
    if (ev.type === "inject.request") return onInject(ev as BusEvent<"inject.request">);
    if (ev.type === "voice.playing") {
      const d = ev.data as BusEvent<"voice.playing">["data"];
      claims?.claim(d.id, d.sink);
      return;
    }
    if (ev.type !== "voice.utterance") return;
    const d = ev.data as BusEvent<"voice.utterance">["data"];
    claims?.seen(d.id);
    if (!isVoiceReady()) {
      log.debug({ id: d.id }, "voice not connected: utterance skipped");
      return;
    }
    void playback.enqueue(d.id, d.audioUrl);
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

export interface StopEarsDeps {
  idleTimer?: ReturnType<typeof setInterval>;
  clear?: (t: ReturnType<typeof setInterval>) => void;
  /** The Discord session (`discord` plan only). */
  session?: { stop(): Promise<void> };
  bus: { stop(): void };
  log?: Pick<Logger, "error">;
}

/** The one shutdown sequence: idle timer, voice connection and Discord client, then the bus. */
// @spec EARS-SESS-008, EARS-START-005
export async function stopEars({ idleTimer, clear = clearInterval, session, bus, log }: StopEarsDeps): Promise<void> {
  if (idleTimer) clear(idleTimer);
  try {
    await session?.stop();
  } catch (err) {
    log?.error({ err }, "discord teardown failed");
  } finally {
    bus.stop();
  }
}
