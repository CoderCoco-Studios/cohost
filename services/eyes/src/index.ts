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
import { Bus, onShutdown, startHeartbeat } from "@cohost/bus";
import { createLogger, loadConfig, urls } from "@cohost/config";
import { Eyes, ollamaDescriber, startEyes, stripDataUrl } from "./eyes.js";
import { EyesHealth } from "./health.js";
import { createInjectHandler } from "./inject.js";

const log = createLogger("eyes");
const cfg = loadConfig();
const bus = new Bus("eyes", log);
const obs = new OBSWebSocket();
const health = new EyesHealth(cfg.vision.enabled, () => obs.identified);
const heartbeat = startHeartbeat(bus, { ...health.spec, log });

async function connectObs(): Promise<void> {
  const { host, port, password } = cfg.vision.obs;
  for (;;) {
    try {
      const { obsWebSocketVersion } = await obs.connect(`ws://${host}:${port}`, password || undefined);
      log.info({ host, port, obsWebSocketVersion }, "connected to OBS");
      heartbeat.ready();
      return;
    } catch (err) {
      log.warn({ err: String(err) }, "OBS not reachable, retrying in 10s");
      await sleep(10_000);
    }
  }
}

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

const describe = health.track(ollamaDescriber(cfg.vision));
const eyes = new Eyes({ bus, log, screenshot, describe });

// Injected images never touch OBS, so this is wired whether vision is enabled or idle.
void bus.subscribe(
  { group: "eyes", types: ["inject.request"], fromNow: true },
  createInjectHandler({ bus, log, dashboardUrl: urls.dashboard(), describe }),
);

async function loop() {
  for (;;) {
    const t0 = Date.now();
    try {
      if (cfg.vision.enabled && obs.identified) await eyes.look();
    } catch (err) {
      log.warn({ err: String(err) }, "look failed");
      if (!obs.identified) await connectObs();
    }
    await sleep(Math.max(500, cfg.vision.interval_ms - (Date.now() - t0)));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

obs.on("ConnectionClosed", () => log.warn("OBS connection closed"));
startEyes({ enabled: cfg.vision.enabled, log, connect: connectObs, loop })
  .then((started) => {
    if (started) return;
    // Disabled: startEyes never connected to OBS. Stay up (mode off) so a supervisor sees a healthy idle service.
    heartbeat.ready();
    const timer = setInterval(() => log.warn("eyes idle: vision.enabled is false"), 60_000);
    onShutdown(() => { clearInterval(timer); });
  })
  .catch((err) => { log.error({ err }, "fatal"); process.exit(1); });
onShutdown(async () => { await obs.disconnect(); bus.stop(); });
