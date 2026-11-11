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
 */
import OBSWebSocket from "obs-websocket-js";
import { Bus } from "@cohost/bus";
import { onShutdown, startHeartbeat, subscribeInject } from "@cohost/shared";
import { createLogger, loadConfig, urls } from "@cohost/config";
import { Eyes, ollamaDescriber, startEyes, stripDataUrl } from "./eyes.js";
import { EyesHealth } from "./health.js";
import { createInjectHandler } from "./inject.js";
import { createObsLink, stopEyes } from "./obs.js";

const log = createLogger("eyes");
const cfg = loadConfig();
const bus = new Bus("eyes", log);
const obs = new OBSWebSocket();
const health = new EyesHealth(cfg.vision.enabled, () => obs.identified);
const heartbeat = startHeartbeat(bus, { ...health.spec, log });

const { host, port, password } = cfg.vision.obs;
// @spec EYES-OBS-001, EYES-OBS-002, EYES-OBS-003, EYES-OBS-004, EYES-HEALTH-005, EYES-HEALTH-006
const link = createObsLink({ obs, url: `ws://${host}:${port}`, password, log, heartbeat });
const fatal = (err: unknown): never => { log.error({ err }, "fatal"); process.exit(1); };

// @spec EYES-OBS-006
async function screenshot(): Promise<string> {
  const { source, width } = cfg.vision.obs;
  const res = await obs.call("GetSourceScreenshot", {
    sourceName: source,
    imageFormat: "jpg",
    imageWidth: width,
    imageCompressionQuality: 70,
  });
  return stripDataUrl(res.imageData);
}

// @spec EYES-HEALTH-003
const describe = health.track(ollamaDescriber(cfg.vision));
const eyes = new Eyes({ bus, log, screenshot, describe });

// Injected images never touch OBS, so this is wired whether vision is enabled or idle. The
// subscription is established before `ready` is signalled (OBS connect, or the idle branch below).
// @spec EYES-ENAB-004, EYES-INJ-001, EYES-INJ-011, EYES-INJ-014
await subscribeInject({
  bus, group: "eyes", log,
  handler: createInjectHandler({
    bus, log, dashboardUrl: urls.dashboard(), describe,
    uploadTimeoutMs: cfg.vision.upload_timeout_ms, uploadMaxBytes: cfg.vision.upload_max_bytes,
  }),
}).catch(fatal);

// @spec EYES-LOOK-003, EYES-LOOK-004, EYES-LOOK-005, EYES-OBS-005
async function loop() {
  for (;;) {
    const t0 = Date.now();
    try {
      if (cfg.vision.enabled && obs.identified) await eyes.look();
    } catch (err) {
      log.warn({ err: String(err) }, "look failed");
      if (!obs.identified) await link.connect();
    }
    await sleep(Math.max(500, cfg.vision.interval_ms - (Date.now() - t0)));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let idleTimer: ReturnType<typeof setInterval> | undefined;
startEyes({ enabled: cfg.vision.enabled, log, connect: link.connect, loop })
  .then((started) => {
    if (started) return;
    // @spec EYES-ENAB-002, EYES-HEALTH-005
    // Disabled: startEyes never connected to OBS. Stay up (mode off) so a supervisor sees a healthy idle service.
    heartbeat.ready();
    idleTimer = setInterval(() => log.warn("eyes idle: vision.enabled is false"), 60_000);
  })
  .catch(fatal);
// One shutdown sequence in both plans.
// @spec EYES-ENAB-005, EYES-OBS-008
onShutdown(() => stopEyes({ idleTimer, link, bus }), log);
