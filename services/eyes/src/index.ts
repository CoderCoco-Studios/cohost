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
import { Bus, onShutdown } from "@cohost/bus";
import { createLogger, loadConfig, urls } from "@cohost/config";

const log = createLogger("eyes");
const cfg = loadConfig();
const bus = new Bus("eyes", log);
const obs = new OBSWebSocket();

if (!cfg.vision.enabled) {
  log.warn("vision.enabled is false in config.yaml — eyes idle. Flip it on and restart.");
}

let previous = "";

async function connectObs(): Promise<void> {
  const { host, port, password } = cfg.vision.obs;
  for (;;) {
    try {
      const { obsWebSocketVersion } = await obs.connect(`ws://${host}:${port}`, password || undefined);
      log.info({ host, port, obsWebSocketVersion }, "connected to OBS");
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
  return res.imageData.replace(/^data:image\/\w+;base64,/, "");
}

async function describe(b64: string): Promise<string> {
  const res = await fetch(`${urls.ollama()}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: cfg.vision.model,
      stream: false,
      keep_alive: "24h",
      options: { temperature: 0.2, num_predict: 60 },
      messages: [
        {
          role: "system",
          content:
            "You watch a live video game stream through a screenshot. Reply with ONE short sentence describing what is happening " +
            "that a co-host would care about: the game, the situation, anything dramatic, funny, or new (menus, deaths, wins, chat on screen). " +
            "No preamble. If nothing meaningful changed versus the previous description, reply exactly: SAME",
        },
        {
          role: "user",
          content: previous ? `Previous description: ${previous}\nWhat is happening now?` : "What is happening now?",
          images: [b64],
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`vision model ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { message?: { content?: string } };
  return (json.message?.content ?? "").trim().split("\n")[0] ?? "";
}

async function loop() {
  for (;;) {
    const t0 = Date.now();
    try {
      if (cfg.vision.enabled && obs.identified) {
        const b64 = await screenshot();
        const text = await describe(b64);
        const same = !text || /^same\b/i.test(text);
        if (!same) {
          previous = text;
          await bus.publish("vision.summary", { text, changed: true });
          log.info({ ms: Date.now() - t0, text }, "saw");
        } else {
          log.debug({ ms: Date.now() - t0 }, "no change");
        }
      }
    } catch (err) {
      log.warn({ err: String(err) }, "look failed");
      if (!obs.identified) await connectObs();
    }
    await sleep(Math.max(500, cfg.vision.interval_ms - (Date.now() - t0)));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

obs.on("ConnectionClosed", () => log.warn("OBS connection closed"));
connectObs().then(loop).catch((err) => { log.error({ err }, "fatal"); process.exit(1); });
onShutdown(async () => { await obs.disconnect(); bus.stop(); });
