import type { Bus, BusEvent, Heartbeat } from "@cohost/bus";
import type { Config, Logger } from "@cohost/config";

/** The guild and voice channel the Discord output joins, from `mouth.outputs.discord.guild_id` / `voice_channel_id`. */
// @spec MOUTH-SESS-002, MOUTH-SESS-003
export function outputTarget(cfg: Config["mouth"]["outputs"]["discord"]): { guildId: string; channelId: string } {
  if (!cfg.guild_id) throw new Error("mouth.outputs.discord.guild_id is not set");
  if (!cfg.voice_channel_id) throw new Error("mouth.outputs.discord.voice_channel_id is not set");
  return { guildId: cfg.guild_id, channelId: cfg.voice_channel_id };
}

export type MouthEventType = "voice.utterance" | "voice.playing";

/** The types the one `mouth` loop reads in the `discord` plan; never `control` (MOUTH-PLAY-008). */
// @spec MOUTH-PLAY-001, MOUTH-PLAY-008
export const MOUTH_LOOP_TYPES = ["voice.utterance", "voice.playing"] as const satisfies readonly MouthEventType[];

/** One enabled output as the loop sees it: a queue that is judged for readiness when an utterance arrives. */
export interface MouthOutput {
  /** The output's name, which is also its sink name. */
  name: string;
  isReady(): boolean;
  playback: { enqueue(id: string, url: string): Promise<void> };
}

export interface MouthHandlerDeps {
  outputs: readonly MouthOutput[];
  log: Pick<Logger, "debug">;
  /** Which utterance ids real sinks claimed (the fallback line's memory, MOUTH-FALL-010). */
  claims?: { seen(id: string): void; claim(id: string, sink: string): void };
}

/**
 * The one `mouth` loop's handler: a `voice.utterance` is queued on every ready output and skipped, without a
 * `voice.failed` or a fallback, on an output that is not ready, so voice's virtual sink covers it when nothing else does.
 * A `voice.playing` only feeds the fallback line's claim memory.
 */
// @spec MOUTH-ROUTE-003, MOUTH-FALL-010, MOUTH-FALL-013
export function createMouthHandler({ outputs, log, claims }: MouthHandlerDeps) {
  return async (ev: BusEvent): Promise<void> => {
    if (ev.type === "voice.playing") {
      const d = ev.data as BusEvent<"voice.playing">["data"];
      claims?.claim(d.id, d.sink);
      return;
    }
    if (ev.type !== "voice.utterance") return;
    const d = ev.data as BusEvent<"voice.utterance">["data"];
    claims?.seen(d.id);
    for (const output of outputs) {
      if (!output.isReady()) {
        log.debug({ id: d.id, output: output.name }, "output not connected: utterance skipped");
        continue;
      }
      void output.playback.enqueue(d.id, d.audioUrl);
    }
  };
}

/** The slice of `Bus` the mouth subscription needs. */
export type MouthBus = Pick<Bus, "resetGroup" | "subscribe">;

/**
 * Subscribe the `mouth` consumer group with start mode `latest`. Resolves once the group exists
 * (`resetGroup` creates it at `$`), so the caller can log in only after the subscription is established;
 * the read loop itself keeps running in the background.
 */
// @spec MOUTH-START-005, MOUTH-PLAY-001
export async function subscribeMouth(bus: MouthBus, handler: (ev: BusEvent) => Promise<void>, log: Pick<Logger, "error">): Promise<void> {
  await bus.resetGroup("mouth");
  bus.subscribe({ group: "mouth", types: MOUTH_LOOP_TYPES, start: "latest" }, handler).catch((err) => {
    log.error({ err }, "mouth subscription failed");
    process.exit(1);
  });
}

export interface StopMouthDeps {
  idleTimer?: ReturnType<typeof setInterval>;
  clear?: (t: ReturnType<typeof setInterval>) => void;
  /** The fallback clip refresh (`discord` plan only). */
  clipSync?: { stop(): void };
  /** The Discord session (`discord` plan only). */
  session?: { stop(): Promise<void> };
  bus: { stop(): void };
  log?: Pick<Logger, "error">;
}

/** The one shutdown sequence: idle timer, clip refresh, voice connection and Discord client, then the bus. */
// @spec MOUTH-SESS-007, MOUTH-START-004
export async function stopMouth({ idleTimer, clear = clearInterval, clipSync, session, bus, log }: StopMouthDeps): Promise<void> {
  if (idleTimer) clear(idleTimer);
  try {
    clipSync?.stop();
    await session?.stop();
  } catch (err) {
    log?.error({ err }, "discord teardown failed");
  } finally {
    bus.stop();
  }
}

export interface IdleDeps {
  log: Pick<Logger, "error" | "warn">;
  heartbeat: Pick<Heartbeat, "ready" | "degraded">;
  /** Repeat interval of the `no-token` warning; 60 s unless a test says otherwise. */
  warnEveryMs?: number;
}

/**
 * The idle plans: no Discord client, no bus subscription, no clips, nothing published but the heartbeat. `off` is
 * `ready` at once; `no-token` is `degraded` with an error now and a warning every 60 s. Returns the warning timer, if any.
 */
// @spec MOUTH-START-001, MOUTH-START-002
export function startIdle(plan: "off" | "no-token", { log, heartbeat, warnEveryMs = 60_000 }: IdleDeps): ReturnType<typeof setInterval> | undefined {
  if (plan === "off") {
    log.warn("no mouth output is enabled: idle, no Discord client, nothing played (mode off)");
    heartbeat.ready();
    return undefined;
  }
  log.error("DISCORD_TOKEN is not set; mouth is idle (no Discord client)");
  heartbeat.degraded("DISCORD_TOKEN is not set");
  return setInterval(() => log.warn("DISCORD_TOKEN is not set; mouth still idle"), warnEveryMs);
}
