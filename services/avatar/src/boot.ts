import type { Bus, BusEvent } from "@cohost/bus";
import { runService, type RunServiceOptions, type ServiceContext } from "@cohost/shared";
import { configDir, createLogger, loadExpressions as loadExpressionsFile, type Config, type ExpressionMap } from "@cohost/config";
import { Engine } from "./engine.js";
import { avatarHealth } from "./health.js";
import { statePublisher } from "./state.js";
import { createDriver as createDriverFor } from "./drivers/index.js";
import type { AvatarDriver } from "./types.js";

/** What boot needs from a Bus (a fake in tests). */
export type AvatarBus = Pick<Bus, "publish" | "publishHealth" | "consumer" | "resetGroup" | "subscribe" | "stop">;

/** The process-level collaborators of the service, replaceable so a test runs it without Redis, an avatar app or signals. */
export type AvatarEnv = Pick<RunServiceOptions<AvatarBus>, "loadConfig" | "createBus" | "onShutdown" | "exit" | "log" | "stopTimeoutMs"> & {
  createDriver?: typeof createDriverFor;
  loadExpressions?: () => ExpressionMap;
  /** Directory the driver may persist small state in (default: the config directory). */
  stateDir?: string;
};

/**
 * The block of `expressions.yaml` named after the active driver (empty maps when it has none), split into the
 * emotion-to-expression map and the gesture map (AVATAR-DRV-005).
 */
export function expressionsFor(all: ExpressionMap, driverName: string): { expressions: Record<string, string>; gestures: Record<string, string> } { // @spec AVATAR-DRV-005
  const { gestures, ...expressions } = all[driverName] ?? { gestures: {} };
  return { expressions, gestures };
}

/**
 * Start the avatar service on the shared bootstrap and run its bus loop until it ends. A failure in any step — the
 * configuration, driver creation, the expressions file, positioning the consumer group, a rejecting `driver.connect`, or a
 * subscription that rejects past the bus's own retry — ends the process with status 1 (AVATAR-BUS-007, AVATAR-BUS-008).
 * Nothing waits for the avatar app.
 */
export async function avatarMain(ctx: ServiceContext<AvatarBus>, driverRef: { current?: AvatarDriver }, env: AvatarEnv = {}): Promise<void> {
  const { cfg, bus, log, heartbeat, onStop } = ctx;
  const exit = env.exit ?? ((code: number) => process.exit(code));
  const fatal = (err: unknown) => { log.error({ err }, "fatal"); exit(1); };
  const driver = (env.createDriver ?? createDriverFor)(cfg.avatar); // @spec AVATAR-DRV-002
  driverRef.current = driver;
  const { expressions, gestures } = expressionsFor((env.loadExpressions ?? loadExpressionsFile)(), cfg.avatar.driver); // @spec AVATAR-DRV-005
  const engine = new Engine(cfg.avatar, driver, statePublisher({ bus, driver, log })); // @spec AVATAR-STATE-001
  onStop(async () => { engine.stop(); await driver.disconnect(); }); // @spec AVATAR-HEALTH-004

  // Not awaited: a first VTube Studio pairing can wait for the operator, and the face must animate meanwhile.
  driver.connect({ log, expressions, gestures, stateDir: env.stateDir ?? configDir() }).catch(fatal); // @spec AVATAR-DRV-006, AVATAR-VTS-002
  engine.start();

  // Ready means "can receive events": the group exists at the newest entry before the loop reads.
  await bus.resetGroup("avatar");
  heartbeat.ready(); // @spec AVATAR-HEALTH-001
  log.info({ driver: driver.name, expressions: Object.keys(expressions).length }, "avatar online");

  // The subscription's start mode is `latest`: a restart never replays stale expressions or lip-sync (AVATAR-BUS-001).
  await bus.subscribe( // @spec AVATAR-BUS-001
    { group: "avatar", types: ["voice.utterance", "voice.playing", "voice.done", "brain.say", "affect.state"], start: "latest" },
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

/** The service entry: bootstrap, then `avatarMain`. */
export function runAvatar(env: AvatarEnv = {}): Promise<void> { // @spec AVATAR-BUS-007, AVATAR-BUS-008
  const { createDriver, loadExpressions, stateDir, ...boot } = env;
  const exit = boot.exit ?? ((code: number) => process.exit(code));
  const log = boot.log ?? createLogger("avatar");
  const driverRef: { current?: AvatarDriver } = {};
  return runService<AvatarBus>({
    service: "avatar",
    health: (cfg: Config) => avatarHealth(cfg, () => driverRef.current),
    main: (ctx) => avatarMain(ctx, driverRef, env),
    ...boot,
    log,
  }).catch((err) => { log.error({ err }, "fatal"); exit(1); }); // a bus that cannot be built is a startup failure too
}
