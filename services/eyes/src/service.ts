/**
 * eyes — looks at the game through OBS and publishes one-line summaries.
 *
 * Grabs a screenshot of an OBS source via obs-websocket (v5, built into OBS 28+)
 * every `vision.interval_ms`, asks the vision model what changed, and publishes
 * `vision.summary`. Summaries, not frames, go on the bus: cheap and what the
 * brain actually wants. Enable in config/config.yaml (vision.enabled) and run
 * with `docker compose --profile eyes up -d`.
 *
 * OBS: Tools > WebSocket Server Settings > Enable, set a password, and if the
 * AI box is another machine, untick "localhost only" / allow LAN.
 *
 * `eyesService(deps)` is the service minus the process: `index.ts` hands its `health` and `main` to `runService`,
 * and a test hands it a fake OBS client.
 */
import type { Bus } from "@cohost/bus";
import { urls, type Config } from "@cohost/config";
import { startIdle, subscribeInject, type HeartbeatSpec, type ServiceContext } from "@cohost/shared";
import { Eyes, createDescriber, startEyes, stripDataUrl, type Describe } from "./eyes.js";
import { EyesHealth } from "./health.js";
import { createInjectHandler } from "./inject.js";
import { createObsLink, stopEyes, type ObsLike } from "./obs.js";

/** The slice of obs-websocket-js's `OBSWebSocket` the service uses. */
export interface ObsClient extends ObsLike {
  call(request: "GetSourceScreenshot", args: { sourceName: string; imageFormat: string; imageWidth: number; imageCompressionQuality: number }): Promise<{ imageData: string }>;
}

export interface EyesServiceDeps {
  obs: ObsClient;
  /** Replaces the describer `vision.engine` selects. */
  createDescriber?: (cfg: Config) => Describe;
  /** Monotonic clock, ms (default `performance.now`). */
  now?: () => number;
  /** Waits between looks and between OBS connection attempts (default a timer). */
  sleep?: (ms: number) => Promise<void>;
  dashboardUrl?: string;
  fetch?: typeof fetch;
  exit?: (code: number) => void;
}

const timerSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// @spec EYES-LOOK-003
/** The wait before the next look: the interval minus what the look took, and never less than 500 ms. */
export const nextDelay = (intervalMs: number, elapsedMs: number): number => Math.max(500, intervalMs - elapsedMs);

export function eyesService(deps: EyesServiceDeps): { health(cfg: Config): HeartbeatSpec; main(ctx: ServiceContext<Bus>): Promise<void> } {
  const { obs } = deps;
  const sleep = deps.sleep ?? timerSleep;
  const now = deps.now ?? (() => performance.now());
  let health: EyesHealth | undefined;

  return {
    // @spec EYES-HEALTH-001, EYES-HEALTH-002, EYES-STUB-002
    health(cfg) {
      health = new EyesHealth(cfg.vision.enabled, () => obs.identified, cfg.vision.engine);
      return health.spec;
    },

    async main({ cfg, bus, log, heartbeat, onStop }) {
      const { host, port, password } = cfg.vision.obs;
      let stopped = false;
      const fatal = (err: unknown): void => { log.error({ err }, "fatal"); (deps.exit ?? process.exit)(1); };

      // @spec EYES-OBS-001, EYES-OBS-002, EYES-OBS-003, EYES-OBS-004, EYES-HEALTH-005, EYES-HEALTH-006
      const link = createObsLink({ obs, url: `ws://${host}:${port}`, password, log, heartbeat, sleep: deps.sleep });

      // @spec EYES-OBS-006
      async function screenshot(): Promise<string> {
        const { source, width } = cfg.vision.obs;
        const res = await obs.call("GetSourceScreenshot", {
          sourceName: source,
          imageFormat: "jpg",
          imageWidth: width,
          imageCompressionQuality: cfg.vision.jpeg_quality,
        });
        return stripDataUrl(res.imageData);
      }

      if (cfg.vision.engine === "stub") log.warn("vision.engine is stub: descriptions are fixed text, no model is called (mode mock)");
      // @spec EYES-HEALTH-003
      const describe = health!.track((deps.createDescriber ?? createDescriber)(cfg));
      const eyes = new Eyes({ bus, log, screenshot, describe, now });

      // Injected images never touch OBS, so this is wired whether vision is enabled or idle. The
      // subscription is established before `ready` is signalled (OBS connect, or the idle plan below).
      // @spec EYES-ENAB-004, EYES-INJ-001, EYES-INJ-011, EYES-INJ-014, EYES-INJ-016
      await subscribeInject({
        bus, group: "eyes", log, exit: deps.exit,
        handler: createInjectHandler({
          bus, log, dashboardUrl: deps.dashboardUrl ?? urls.dashboard(), describe, fetch: deps.fetch,
          uploadTimeoutMs: cfg.vision.upload_timeout_ms, uploadMaxBytes: cfg.vision.upload_max_bytes,
        }),
      });

      // @spec EYES-LOOK-003, EYES-LOOK-004, EYES-LOOK-005, EYES-OBS-005
      async function loop(): Promise<void> {
        while (!stopped) {
          const t0 = now();
          try {
            if (obs.identified) await eyes.look();
          } catch (err) {
            log.warn({ err: String(err) }, "look failed");
            if (!obs.identified) await link.connect();
          }
          await sleep(nextDelay(cfg.vision.interval_ms, now() - t0));
        }
      }

      // @spec EYES-ENAB-001, EYES-ENAB-002, EYES-ENAB-003, EYES-HEALTH-005
      // Disabled: no OBS connection and no loop. Stay up (mode off) so a supervisor sees a healthy idle service.
      const idle = cfg.vision.enabled ? undefined : startIdle({ heartbeat, log, kind: "off", reason: "vision.enabled is false in config.yaml: eyes idle. Flip it on and restart." });
      // One shutdown sequence in both plans.
      // @spec EYES-ENAB-005, EYES-OBS-008
      onStop(() => { stopped = true; return stopEyes({ idle, link }); });
      if (cfg.vision.enabled) void startEyes({ enabled: true, connect: link.connect, loop }).catch(fatal);
    },
  };
}
