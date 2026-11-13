import { FrameSequencer, type ConnectorRegistry, type Publisher } from "@cohost/bus";
import type { Logger } from "@cohost/config";
import { writeUtterance, type UtteranceWriterOptions } from "@cohost/shared";
import type { FallbackLine } from "./fallback.js";
import { Playback, httpAudio, type PlaybackDeps } from "./playback.js";
import type { MouthOutput } from "./session.js";

/** What the output needs of the bus: `voice.*` events and audio frames. */
export type ConnectorOutputBus = Publisher & { publishFrame(dir: "out", tag: string, frame: Parameters<UtteranceWriterOptions["write"]>[0]): Promise<unknown> };

export interface ConnectorOutputDeps {
  bus: ConnectorOutputBus;
  registry: ConnectorRegistry;
  log: Logger;
  /** The sink's tag, which is also the output's name and the sink name it reports (`discord`, MOUTH-ROUTE-001). */
  tag: string;
  /** The live `gain_db` (MOUTH-LIVE-002). */
  gainDb: () => number;
  /** This output's fallback line over the shared clip cache; without it a give-up is a silent skip. */
  fallback?: FallbackLine;
  // Replacements for tests.
  fetchAudio?: (url: string) => Promise<Buffer>;
  clock?: Pick<UtteranceWriterOptions, "now" | "sleep">;
  guard?: Pick<PlaybackDeps, "fetchTimeoutMs" | "watchdogGraceMs" | "maxQueue">;
}

/** The output the bus loop feeds; `close` cancels the pending completion for shutdown. */
export type ConnectorOutput = MouthOutput & { playback: Playback; close(): void };

/** Length of one frame the writer cuts, ms (CONN-AUD-002). */
const FRAME_MS = 20;

/**
 * A sink served by a connector (the `discord` output): it delivers each line by writing paced frames to `audio.out.<tag>`
 * in the format the sink's registration declares, and is ready only while a live registration offers the sink ready.
 * `voice.playing` follows the first frame written; `voice.done` follows the line's own write schedule (its start plus its
 * length), not anything the connector reports, so a sink that goes away mid-line still finishes the line on schedule.
 */
// @spec MOUTH-CONN-002, MOUTH-CONN-003, MOUTH-CONN-004, MOUTH-CONN-005, CONN-AUD-005, CONN-BP-004, CONN-BP-005, MOUTH-PLAY-003, MOUTH-PLAY-004
export function createConnectorOutput(d: ConnectorOutputDeps): ConnectorOutput {
  const sequencer = new FrameSequencer();
  const now = d.clock?.now ?? (() => performance.now());
  const sleep = d.clock?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  /** Bumped when a line ends or is abandoned, so a pending completion of an earlier line does nothing. */
  let line = 0;
  let closed = false;

  const playback: Playback = new Playback({
    bus: d.bus, log: d.log, sink: d.tag, gainDb: d.gainDb, fallback: d.fallback, fetchAudio: d.fetchAudio ?? httpAudio,
    // The player is the frame writer: this resolves once the first frame is out and rejects when it cannot go out.
    play: (pcm, id) => {
      const offer = d.registry.offer("audio-out", d.tag);
      if (!offer) return Promise.reject(new Error(`sink ${d.tag} is not registered`));
      const mine = ++line;
      const startedAt = now();
      const durationMs = Math.ceil(pcm.length / (48_000 * 4) / (FRAME_MS / 1000)) * FRAME_MS;
      let first = false;
      let abandoned = false;
      return new Promise<void>((resolve, reject) => {
        const write = async (frame: Parameters<ConnectorOutputBus["publishFrame"]>[2]): Promise<void> => {
          try {
            await d.bus.publishFrame("out", d.tag, frame);
          } catch (err) {
            if (!first) { first = true; abandoned = true; reject(err); }
            throw err;
          }
          if (!first) { first = true; resolve(); }
        };
        writeUtterance(
          { write, sequencer, format: offer.cap.format, now, sleep, abort: () => abandoned || mine !== line || closed },
          { utt: id, pcm, from: { rate: 48_000, channels: 2 } },
        ).then(async () => {
          if (abandoned) return;
          // The last frame's play time is the line's start plus its length; the writer runs up to a lead ahead of that.
          const remaining = startedAt + durationMs - now();
          if (remaining > 0) await sleep(remaining);
          if (mine === line && !closed) void playback.onIdle();
        }, (err) => { if (!first) { first = true; abandoned = true; reject(err); } else d.log.warn({ err: String(err), output: d.tag }, "audio write failed"); });
      });
    },
    // The watchdog's way out of a stuck line: abandon what is pending, ending no item itself.
    stop: () => { line++; },
    ...d.guard,
  });

  return {
    name: d.tag,
    isReady: () => d.registry.ready("audio-out", d.tag) !== undefined,
    playback,
    close: () => { closed = true; line++; playback.close(); },
  };
}
