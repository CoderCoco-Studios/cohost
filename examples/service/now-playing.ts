// An example service: it watches a text file (the "now playing" file many streaming setups write) and tells the
// co-host when the song changes. Run it with the path of the file:
//   node --import tsx examples/service/now-playing.ts path/to/song.txt
// It is built on the shared runtime from the first line, as every cohost service is. The workspace packages are
// imported by path here because this folder is not a workspace package; inside a service folder they are imported as
// "@cohost/bus" and "@cohost/shared".
import { readFileSync } from "node:fs";
import type { Bus, Publisher } from "../../packages/bus/dist/index.js";
import { runService, type HealthPublisher, type RunServiceOptions, type ServiceContext } from "../../packages/shared/dist/index.js";

// #region types
/** What the service needs from a Bus; tests pass a fake. */
export type NowPlayingBus = Publisher & HealthPublisher & Pick<Bus, "subscribe" | "resetGroup" | "stop">;

/** What the heartbeat reads: `undefined` until the first read, then whether the last read worked. */
export interface FileState { ok?: boolean }
// #endregion types

// #region main
export async function nowPlayingMain( // @spec MOD-EX-001, MOD-EX-002, MOD-EX-003, MOD-EX-004, MOD-EX-005
  ctx: ServiceContext<NowPlayingBus>,
  opts: { file: string; pollMs?: number },
  state: FileState = {},
): Promise<void> {
  const { bus, log, heartbeat, onStop } = ctx;
  let lastTitle = "";
  let stopped = false;

  // 1. Join the bus: a consumer group of our own, starting at the newest entry, so we never replay old lines.
  await bus.resetGroup("now-playing");
  void bus.subscribe({ group: "now-playing", types: ["brain.say"], start: "latest" }, (ev) => {
    if (lastTitle && ev.data.text.toLowerCase().includes(lastTitle.toLowerCase())) {
      log.info({ text: ev.data.text }, "co-host mentioned the song");
    }
  }).catch((err) => log.error({ err }, "subscription ended"));

  // 2. Sense the world: read the file now and on a timer, and publish when the title changes.
  const poll = async (): Promise<void> => {
    let title: string;
    try {
      title = readFileSync(opts.file, "utf8").trim();
      state.ok = true;
    } catch {
      state.ok = false;
      return;
    }
    if (stopped || !title || title === lastTitle) return;
    lastTitle = title;
    try {
      await bus.publish("vision.summary", { text: `Now playing: ${title}`, changed: true });
    } catch (err) {
      log.warn({ err }, "could not publish the song");
    }
  };
  await poll();
  const timer = setInterval(() => void poll(), opts.pollMs ?? 2000);

  // 3. Clean up when stopped, then 4. say we are ready.
  onStop(() => { stopped = true; clearInterval(timer); });
  heartbeat.ready();
  log.info({ file: opts.file }, "now-playing online");
}
// #endregion main

// #region entry
/** The service entry: the bootstrap builds the logger, config, bus and heartbeat, then calls `nowPlayingMain`. */
export function runNowPlaying(
  opts: { file: string; pollMs?: number },
  env: Pick<RunServiceOptions<NowPlayingBus>, "loadConfig" | "createBus" | "onShutdown" | "exit" | "log"> = {},
): Promise<void> {
  const state: FileState = {};
  return runService<NowPlayingBus>({
    service: "now-playing",
    // The Services screen shows `degraded`, with the reason, while the file cannot be read.
    health: () => ({
      service: "now-playing",
      mode: "live",
      deps: () => ({ file: state.ok ? "ok" : "down" }),
    }),
    main: (ctx) => nowPlayingMain(ctx, opts, state),
    ...env,
  });
}

if (process.argv[1] === import.meta.filename) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: node --import tsx examples/service/now-playing.ts <path to the now-playing file>");
    process.exit(1);
  }
  void runNowPlaying({ file });
}
// #endregion entry
