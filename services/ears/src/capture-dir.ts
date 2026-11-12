import { mkdir, readdir, readFile, rename as fsRename, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "@cohost/config";
import { INJECT_QUEUE_LIMIT } from "@cohost/shared";
import { ClipError, decodeClip, type CaptureAdapter, type HearClip } from "./capture.js";
import { INJECT_MAX_BYTES } from "./inject.js";

export interface DirCaptureOptions {
  path: string;
  pollMs: number;
  hear: HearClip;
  log: Pick<Logger, "info" | "warn" | "error">;
  /** Largest accepted file (default `INJECT_MAX_BYTES`, the shared inject cap). */
  maxBytes?: number;
  /** Files taken per poll (default `INJECT_QUEUE_LIMIT`). */
  batch?: number;
  /** Replacement for `fs.rename`, for tests. */
  rename?: (from: string, to: string) => Promise<void>;
}

export interface DirCapture extends CaptureAdapter {
  /** One poll now (the timer calls this); resolves when its files are processed. */
  pollOnce(): Promise<void>;
}

// @spec EARS-CAP-008, EARS-CAP-009, EARS-CAP-012
/**
 * The `dir` capture source: polls a directory for dropped `.wav` files. A file is read once its size is the same on two
 * consecutive polls (it is no longer being written), goes through the `Hearing` path as speaker `dir`, and is renamed
 * with a suffix saying what became of it. Polling (not `fs.watch`) behaves the same on WSL, bind mounts and network shares.
 */
export function createDirCapture(o: DirCaptureOptions): DirCapture {
  const maxBytes = o.maxBytes ?? INJECT_MAX_BYTES;
  const batch = o.batch ?? INJECT_QUEUE_LIMIT;
  const rename = o.rename ?? fsRename;
  /** Size seen at the previous poll, per file still waiting to settle. */
  const pending = new Map<string, number>();
  /** Files that could not be renamed: never read again. */
  const skip = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let up = false;
  let stopped = true;

  async function finish(name: string, suffix: string): Promise<void> {
    pending.delete(name);
    try {
      await rename(join(o.path, name), join(o.path, `${name}.${suffix}`));
    } catch (err) {
      skip.add(name);
      o.log.warn({ err: String(err), file: name }, "ears dir: could not rename a processed file; it will not be read again");
    }
  }

  async function process(name: string, size: number): Promise<void> {
    if (size > maxBytes) {
      o.log.warn({ file: name, size }, "ears dir: file over the byte cap");
      return finish(name, "rejected");
    }
    let clip;
    try {
      clip = decodeClip(await readFile(join(o.path, name)), "audio/wav");
    } catch (err) {
      o.log.warn({ file: name, err: err instanceof ClipError ? err.message : String(err) }, "ears dir: file is not readable 16-bit WAV audio");
      return finish(name, "rejected");
    }
    const outcome = await o.hear(clip, "dir");
    return finish(name, !outcome.heard && outcome.reason === "stt-error" ? "failed" : "done");
  }

  async function poll(): Promise<void> {
    let entries;
    try {
      entries = await readdir(o.path, { withFileTypes: true });
    } catch (err) {
      if (up) o.log.warn({ err: String(err), path: o.path }, "ears dir: cannot read the directory");
      up = false;
      return;
    }
    up = true;
    const wavs = entries.filter((e) => e.isFile() && /\.wav$/i.test(e.name) && !skip.has(e.name)).map((e) => e.name).sort();
    const present = new Set(wavs);
    for (const name of [...pending.keys()]) if (!present.has(name)) pending.delete(name);
    const ready: [string, number][] = [];
    for (const name of wavs) {
      let size: number;
      try {
        size = (await stat(join(o.path, name))).size;
      } catch {
        pending.delete(name);
        continue;
      }
      if (pending.get(name) === size) {
        if (ready.length < batch) ready.push([name, size]);
      } else {
        pending.set(name, size);
      }
    }
    for (const [name, size] of ready) await process(name, size);
  }

  const pollOnce = (): Promise<void> => {
    running = (running ?? Promise.resolve()).then(poll).catch((err) => o.log.error({ err: String(err) }, "ears dir poll failed"));
    return running;
  };

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => { void pollOnce().then(schedule); }, o.pollMs);
  };

  return {
    name: "dir",
    status: () => (up ? "ok" : "down"),
    pollOnce,
    async start() {
      await mkdir(o.path, { recursive: true });
      stopped = false;
      up = true;
      o.log.info({ path: o.path, pollMs: o.pollMs }, "ears dir polling for .wav files");
      schedule();
    },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await running;
      up = false;
    },
  };
}
