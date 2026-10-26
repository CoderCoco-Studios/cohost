/**
 * avatar — drives whatever avatar app you run (2D or 3D) from bus events.
 * Pick the app with AVATAR_DRIVER in .env; map emotions in config/expressions.yaml.
 */
import { Bus, onShutdown, startHeartbeat, type BusEvent } from "@cohost/bus";
import { configDir, createLogger, loadConfig, loadExpressions } from "@cohost/config";
import { createDriver } from "./drivers/index.js";
import { Engine } from "./engine.js";
import { avatarHealth } from "./health.js";

const log = createLogger("avatar");
const cfg = loadConfig();
const bus = new Bus("avatar", log);
const driver = createDriver(cfg.avatar);
const heartbeat = startHeartbeat(bus, { ...avatarHealth(driver), log });
heartbeat.ready(); // driver selected; deps.driver follows its connection

const exprCfg = loadExpressions()[cfg.avatar.driver] ?? { gestures: {} };
const { gestures, ...expressions } = exprCfg;

let lastPublished = 0;
const engine = new Engine(cfg.avatar, driver, (p, emotion, intensity) => {
  const now = Date.now();
  if (now - lastPublished < 200) return; // 5 Hz is plenty for the dashboard preview
  lastPublished = now;
  void bus.publish("avatar.state", { ...p, emotion, intensity, driver: driver.name, connected: driver.connected() });
});

async function main() {
  await driver.connect({ log, expressions, gestures, stateDir: configDir() });
  log.info({ driver: driver.name, capabilities: [...driver.capabilities()], expressions: Object.keys(expressions).length }, "avatar online");
  engine.start();

  void bus.subscribe(
    { group: "avatar", types: ["voice.utterance", "voice.playing", "voice.done", "brain.say", "affect.state"], fromNow: true },
    (ev: BusEvent) => {
      switch (ev.type) {
        case "brain.say": {
          // Show the emotion as soon as it decides, before audio exists — feels more alive.
          const d = ev.data as BusEvent<"brain.say">["data"];
          engine.setEmotion(d.emotion, 6000);
          break;
        }
        case "voice.utterance": {
          const d = ev.data as BusEvent<"voice.utterance">["data"];
          engine.prepare({ id: d.id, emotion: d.emotion, gesture: d.gesture, envelope: d.envelope, envelopeHz: d.envelopeHz, durationMs: d.durationMs });
          break;
        }
        case "affect.state": engine.setMood((ev.data as BusEvent<"affect.state">["data"]).mood); break;
        case "voice.playing": engine.play((ev.data as BusEvent<"voice.playing">["data"]).id); break;
        case "voice.done": engine.done((ev.data as BusEvent<"voice.done">["data"]).id); break;
      }
    },
  );
}

main().catch((err) => { log.error({ err }, "fatal"); process.exit(1); });
onShutdown(async () => { engine.stop(); await driver.disconnect(); bus.stop(); });
