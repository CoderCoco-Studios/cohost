/**
 * A sink with no audio device: it fetches each line like any output, hands the WAV to `deliver` (nothing, for `dryrun`),
 * claims the line with `voice.playing`, and releases it with `voice.done` once the WAV's own duration has passed, so voice,
 * avatar and cortex see a sink that finishes when the line would have finished. Shared by the `dryrun`, `file` and `http` outputs.
 */
import type { Publisher } from "@cohost/bus";
import type { Logger } from "@cohost/config";
import { parseWav } from "@cohost/shared";
import { Playback, httpAudio, type PlaybackDeps } from "./playback.js";

export interface TimedDeps {
  bus: Publisher;
  log: Logger;
  /** The output's sink name (MOUTH-ROUTE-001). */
  sink: string;
  fallback?: PlaybackDeps["fallback"];
  fetchAudio?: (url: string) => Promise<Buffer>;
  /** Take the WAV of utterance `id`; a throw is a failed hand-over (MOUTH-PLAY-005). Absent: the WAV goes nowhere. */
  deliver?: (wav: Buffer, id: string) => void;
}

export interface TimedPlayback {
  playback: Playback;
  /** Cancel the pending release timer and the watchdog; for shutdown. */
  close(): void;
}

// @spec MOUTH-DRY-002, MOUTH-FILE-001, MOUTH-HTTP-001
export function createTimedPlayback({ bus, log, sink, fallback, fetchAudio = httpAudio, deliver }: TimedDeps): TimedPlayback {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const box: { playback?: Playback } = {};

  const playback = new Playback({
    bus, log, sink, gainDb: 0, fallback, fetchAudio,
    // The WAV itself is the "audio": checked by parseWav, read for its duration, delivered as synthesized.
    prepare: (wav) => { parseWav(wav); return wav; },
    durationOf: (wav) => parseWav(wav).durationMs,
    play: (wav, id) => {
      deliver?.(wav, id);
      clearTimeout(timer);
      timer = setTimeout(() => void box.playback!.onIdle(), parseWav(wav).durationMs);
    },
    stop: () => { clearTimeout(timer); timer = undefined; },
  });
  box.playback = playback;

  return {
    playback,
    close() {
      clearTimeout(timer);
      timer = undefined;
      playback.close();
    },
  };
}
