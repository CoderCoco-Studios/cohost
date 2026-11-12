import type { Bus, BusEvent, Publisher } from "@cohost/bus";
import type { Config, Logger } from "@cohost/config";
import { OUTPUT_KINDS } from "./health.js";

/** The guild and voice channel the Discord output joins, from `mouth.outputs.discord.guild_id` / `voice_channel_id`. */
// @spec MOUTH-SESS-002, MOUTH-SESS-003
export function outputTarget(cfg: Config["mouth"]["outputs"]["discord"]): { guildId: string; channelId: string } {
  if (!cfg.guild_id) throw new Error("mouth.outputs.discord.guild_id is not set");
  if (!cfg.voice_channel_id) throw new Error("mouth.outputs.discord.voice_channel_id is not set");
  return { guildId: cfg.guild_id, channelId: cfg.voice_channel_id };
}

export type MouthEventType = "voice.utterance" | "voice.playing" | "control";

/** The types the one `mouth` loop reads in the `discord` and `local` plans; `control` is acted on only for `set_routing` (MOUTH-PLAY-008). */
// @spec MOUTH-PLAY-001, MOUTH-PLAY-008
export const MOUTH_LOOP_TYPES = ["voice.utterance", "voice.playing", "control"] as const satisfies readonly MouthEventType[];

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
  log: Pick<Logger, "debug" | "warn">;
  /** Where mouth publishes the `voice.playing` and `voice.done` it gives a line that goes to no output (MOUTH-ROUTE-008). */
  bus: Pick<Publisher, "publish">;
  /** Told the ids of a `route` that are not output kinds, so the heartbeat can say they were ignored (MOUTH-ROUTE-007). */
  onUnknownRoute?: (ids: string[]) => void;
  /** Which utterance ids real sinks claimed (the fallback line's memory, MOUTH-FALL-010). */
  claims?: { seen(id: string): void; claim(id: string, sink: string): void };
  /** Whether an output is switched on live (`set_routing`); an output switched off skips utterances like a disabled one. Default: all on. */
  enabled?: (name: string) => boolean;
  /** The shared `control` reader, given every `control` event on the loop; mouth's only handler is `set_routing`. */
  control?: { handleAsync(ev: BusEvent): Promise<boolean> };
}

/**
 * The one `mouth` loop's handler: a `voice.utterance` is queued on every ready output and skipped, without a
 * `voice.failed` or a fallback, on an output that is not ready, so voice's virtual sink covers it when nothing else does.
 * A `voice.playing` only feeds the fallback line's claim memory; a `control` goes to the shared reader (`set_routing`).
 */
// @spec MOUTH-ROUTE-003, MOUTH-ROUTE-006, MOUTH-ROUTE-007, MOUTH-ROUTE-008, MOUTH-FALL-010, MOUTH-FALL-013, MOUTH-LIVE-001, MOUTH-LIVE-002
export function createMouthHandler({ outputs, log, bus, onUnknownRoute, claims, enabled, control }: MouthHandlerDeps) {
  return async (ev: BusEvent): Promise<void> => {
    if (ev.type === "control") {
      await control?.handleAsync(ev);
      return;
    }
    if (ev.type === "voice.playing") {
      const d = ev.data as BusEvent<"voice.playing">["data"];
      claims?.claim(d.id, d.sink);
      return;
    }
    if (ev.type !== "voice.utterance") return;
    const d = ev.data as BusEvent<"voice.utterance">["data"];
    claims?.seen(d.id);
    const route = d.route;
    if (route) {
      const unknown = route.filter((id) => !(OUTPUT_KINDS as readonly string[]).includes(id));
      if (unknown.length > 0) {
        log.debug({ id: d.id, unknown }, "route names unknown output ids: ignored");
        onUnknownRoute?.(unknown);
      }
      // A line that goes to no enabled output is completed here, so cortex is released and no fallback clip plays for it.
      if (!outputs.some((o) => route.includes(o.name) && (!enabled || enabled(o.name)))) {
        try {
          await bus.publish("voice.playing", { id: d.id, sink: "mouth" });
          await bus.publish("voice.done", { id: d.id, sink: "mouth" });
        } catch (err) {
          log.warn({ err, id: d.id }, "publishing the completion of an unrouted line failed");
        }
        return;
      }
    }
    for (const output of outputs) {
      if (route && !route.includes(output.name)) continue;
      if (enabled && !enabled(output.name)) continue;
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
