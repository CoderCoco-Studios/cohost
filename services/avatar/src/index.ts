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
const driver = createDriver(cfg.avatar); // @spec AVATAR-DRV-002
const heartbeat = startHeartbeat(bus, { ...avatarHealth(driver), log });
heartbeat.ready(); // driver selected; deps.driver follows its connection. @spec AVATAR-HEALTH-001

const exprCfg = loadExpressions()[cfg.avatar.driver] ?? { gestures: {} }; // @spec AVATAR-DRV-005
const { gestures, ...expressions } = exprCfg;

let lastPublished = 0;
const engine = new Engine(cfg.avatar, driver, (p, emotion, intensity) => { // @spec AVATAR-STATE-001
  const now = Date.now();
  if (now - lastPublished < 200) return; // 5 Hz is plenty for the dashboard preview
  lastPublished = now;
  void bus.publish("avatar.state", { ...p, emotion, intensity, driver: driver.name, connected: driver.connected() });
});

async function main() {
  await driver.connect({ log, expressions, gestures, stateDir: configDir() }); // @spec AVATAR-DRV-006
  log.info({ driver: driver.name, capabilities: [...driver.capabilities()], expressions: Object.keys(expressions).length }, "avatar online");
  engine.start();

  void bus.subscribe( // @spec AVATAR-BUS-001
    { group: "avatar", types: ["voice.utterance", "voice.playing", "voice.done", "brain.say", "affect.state"], fromNow: true },
    (ev: BusEvent) => {
      switch (ev.type) {
        case "brain.say": { // @spec AVATAR-BUS-002
          // Show the emotion as soon as it decides, before audio exists — feels more alive.
          const d = ev.data as BusEvent<"brain.say">["data"];
          engine.setEmotion(d.emotion, 6000);
          break;
        }
        case "voice.utterance": { // @spec AVATAR-BUS-003
          const d = ev.data as BusEvent<"voice.utterance">["data"];
          engine.prepare({ id: d.id, emotion: d.emotion, gesture: d.gesture, envelope: d.envelope, envelopeHz: d.envelopeHz, durationMs: d.durationMs });
          break;
        }
        case "affect.state": engine.setMood((ev.data as BusEvent<"affect.state">["data"]).mood); break; // @spec AVATAR-BUS-006
        case "voice.playing": engine.play((ev.data as BusEvent<"voice.playing">["data"]).id); break; // @spec AVATAR-BUS-004
        case "voice.done": engine.done((ev.data as BusEvent<"voice.done">["data"]).id); break; // @spec AVATAR-BUS-005
      }
    },
  );
}

main().catch((err) => { log.error({ err }, "fatal"); process.exit(1); }); // @spec AVATAR-BUS-007
onShutdown(async () => { engine.stop(); await driver.disconnect(); bus.stop(); }); // @spec AVATAR-HEALTH-004
