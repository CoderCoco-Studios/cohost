/**
 * The `dryrun` output: a sink that needs no account or device. It fetches each line like any output, claims it with
 * `voice.playing`, waits the WAV's duration and releases it with `voice.done`, sending no audio anywhere, so mouth, voice,
 * avatar and cortex can be exercised with no Discord. `fail_every` makes it give up on every n-th line to run the fallback line.
 */
import type { Publisher } from "@cohost/bus";
import type { Logger } from "@cohost/config";
import { parseWav } from "@cohost/shared";
import { Playback, httpAudio, type PlaybackDeps } from "./playback.js";
import type { MouthOutput } from "./session.js";

/** The `dryrun` output's name, which is also its sink name (MOUTH-ROUTE-001). */
export const DRYRUN = "dryrun";

export interface DryrunDeps {
  bus: Publisher;
  log: Logger;
  /** `mouth.outputs.dryrun.fail_every`: give up on every n-th utterance, 0 = never. */
  failEvery: number;
  fallback?: PlaybackDeps["fallback"];
  fetchAudio?: (url: string) => Promise<Buffer>;
}

export interface DryrunOutput extends MouthOutput {
  playback: Playback;
  /** Cancel the pending "played" timer and the watchdog; for shutdown. */
  close(): void;
}

// @spec MOUTH-DRY-001, MOUTH-DRY-002, MOUTH-DRY-003
export function createDryrunOutput({ bus, log, failEvery, fallback, fetchAudio = httpAudio }: DryrunDeps): DryrunOutput {
  let dequeued = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const box: { playback?: Playback } = {};

  const playback = new Playback({
    bus, log, sink: DRYRUN, gainDb: 0, fallback,
    // One call per dequeued utterance (fallback clips never reach it), so the count is the n-th line.
    fetchAudio: async (url) => {
      dequeued++;
      if (failEvery > 0 && dequeued % failEvery === 0) throw new Error(`dryrun: simulated failure (fail_every ${failEvery})`);
      return fetchAudio(url);
    },
    // The WAV itself is the "audio": checked by parseWav, read for its duration, and sent nowhere.
    prepare: (wav) => { parseWav(wav); return wav; },
    durationOf: (wav) => parseWav(wav).durationMs,
    play: (wav) => {
      clearTimeout(timer);
      timer = setTimeout(() => void box.playback!.onIdle(), parseWav(wav).durationMs);
    },
    stop: () => { clearTimeout(timer); timer = undefined; },
  });
  box.playback = playback;

  return {
    name: DRYRUN,
    isReady: () => true,
    playback,
    close() {
      clearTimeout(timer);
      timer = undefined;
      playback.close();
    },
  };
}
