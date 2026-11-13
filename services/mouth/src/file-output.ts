/**
 * The `file` output: appends each line's WAV to a directory under the data directory and keeps the newest `max_files`,
 * so the directory is bounded. It claims each line and releases it after the WAV's duration like any sink (timed.ts).
 */
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Publisher } from "@cohost/bus";
import type { Logger } from "@cohost/config";
import type { Playback } from "./playback.js";
import type { MouthOutput } from "./session.js";
import { createTimedPlayback } from "./timed.js";

/** The `file` output's name, which is also its sink name (MOUTH-ROUTE-001). */
export const FILE = "file";

export interface FileOutputDeps {
  bus: Publisher;
  log: Logger;
  /** Absolute directory: `<dataDir()>/<mouth.outputs.file.dir>`. */
  dir: string;
  /** `mouth.outputs.file.max_files`. */
  maxFiles: number;
  fetchAudio?: (url: string) => Promise<Buffer>;
}

export interface FileOutput extends MouthOutput {
  playback: Playback;
  close(): void;
}

// @spec MOUTH-FILE-001, MOUTH-FILE-002, MOUTH-FILE-003
export function createFileOutput({ bus, log, dir, maxFiles, fetchAudio }: FileOutputDeps): FileOutput {
  let seq = 0;

  /** Delete the oldest `.wav` files until at most `maxFiles` remain; names sort oldest first (epoch ms, then sequence). */
  const rotate = () => {
    const wavs = readdirSync(dir).filter((f) => f.endsWith(".wav")).sort();
    for (const old of wavs.slice(0, Math.max(0, wavs.length - maxFiles))) {
      try { unlinkSync(join(dir, old)); } catch (err) { log.warn({ err: String(err), file: old }, "file output: could not delete an old file"); }
    }
  };

  const timed = createTimedPlayback({
    bus, log, sink: FILE, fetchAudio,
    // A throw (no directory, not writable) is a failed hand-over: the output gives up on the line.
    deliver: (wav, id) => {
      mkdirSync(dir, { recursive: true });
      const name = `${Date.now()}-${String(seq++).padStart(6, "0")}-${id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64)}.wav`;
      writeFileSync(join(dir, name), wav);
      rotate();
    },
  });

  return { name: FILE, isReady: () => true, playback: timed.playback, stop: (o) => timed.playback.stop(o), close: timed.close };
}
