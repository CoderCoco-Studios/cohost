import { onShutdown, startHeartbeat, type Bus, type BusEvent, type SubscribeStart } from "@cohost/bus";
import type { Config, Logger } from "@cohost/config";
import { Engine } from "./engine.js";
import { avatarHealth } from "./health.js";
import { statePublisher } from "./state.js";
import type { AvatarDriver } from "./types.js";

/** What boot needs from a Bus (a fake in tests). */
export type AvatarBus = Pick<Bus, "publish" | "publishHealth" | "consumer" | "resetGroup" | "subscribe" | "stop">;

export interface AvatarSetup {
  cfg: Config;
  bus: AvatarBus;
  driver: AvatarDriver;
  /** Emotion → app-specific expression name, for the active driver. */
  expressions: Record<string, string>;
  /** Gesture → app-specific name, for the active driver. */
  gestures: Record<string, string>;
  /** Directory the driver may persist small state in. */
  stateDir: string;
}

export interface AvatarBoot {
  log: Logger;
  /** Load config, build the bus, create the driver, load expressions. Runs inside the fatal handler, so a failure here logs `fatal`. */
  setup(): AvatarSetup;
  onShutdown?: (fn: () => void | Promise<void>) => void;
  exit?: (code: number) => void;
}

/** The avatar subscription's start mode: a restart never replays stale expressions or lip-sync (AVATAR-BUS-001). */
const START: SubscribeStart = "latest";

/**
 * Start the avatar service and run its bus loop until it ends. Every startup step runs here, so any failure — setup,
 * a rejecting `driver.connect`, positioning the consumer group, or a subscription that rejects past the bus's own
 * retry — is logged with message `fatal` and ends the process with status 1. Nothing waits for the avatar app.
 */
export async function runAvatar(boot: AvatarBoot): Promise<void> { // @spec AVATAR-BUS-007, AVATAR-BUS-008
  const { log } = boot;
  const fatal = (err: unknown) => {
    log.error({ err }, "fatal");
    (boot.exit ?? ((code: number) => process.exit(code)))(1);
  };
  try {
    const { cfg, bus, driver, expressions, gestures, stateDir } = boot.setup(); // @spec AVATAR-DRV-002, AVATAR-DRV-005
    const heartbeat = startHeartbeat(bus, { ...avatarHealth(driver), log });
    const engine = new Engine(cfg.avatar, driver, statePublisher({ bus, driver, log })); // @spec AVATAR-STATE-001
    (boot.onShutdown ?? onShutdown)(async () => { engine.stop(); await driver.disconnect(); bus.stop(); }); // @spec AVATAR-HEALTH-004

    // Not awaited: a first VTube Studio pairing can wait for the operator, and the face must animate meanwhile.
    driver.connect({ log, expressions, gestures, stateDir }).catch(fatal); // @spec AVATAR-DRV-006, AVATAR-VTS-002
    engine.start();

    // Ready means "can receive events": the group exists at the newest entry before the loop reads.
    await bus.resetGroup("avatar");
    heartbeat.ready(); // @spec AVATAR-HEALTH-001
    log.info({ driver: driver.name, expressions: Object.keys(expressions).length }, "avatar online");

    await bus.subscribe( // @spec AVATAR-BUS-001
      { group: "avatar", types: ["voice.utterance", "voice.playing", "voice.done", "brain.say", "affect.state"], start: START },
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
  } catch (err) {
    fatal(err);
  }
}
