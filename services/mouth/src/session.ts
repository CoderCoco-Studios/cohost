import type { Bus, BusEvent } from "@cohost/bus";
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
  /** Cancel the output's timers; for shutdown. */
  close?(): void;
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
