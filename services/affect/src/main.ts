import type { Bus, Publisher } from "@cohost/bus";
import { runService, type HealthPublisher, type RunServiceOptions, type ServiceContext } from "@cohost/shared";
import { createLogger, type Config } from "@cohost/config";
import { createAppraiser as createAppraiserFor } from "./appraise.js";
import { Affect } from "./affect.js";
import { affectHealth } from "./health.js";

/** What `main` needs from a Bus; tests pass a fake. */
export type AffectBus = Publisher & HealthPublisher & Pick<Bus, "subscribe" | "resetGroup" | "stop">;

/** The process-level collaborators of the service, replaceable so a test runs it without Redis, signals or exit. */
export type AffectEnv = Pick<RunServiceOptions<AffectBus>, "loadConfig" | "createBus" | "onShutdown" | "exit" | "log" | "stopTimeoutMs"> & {
  createAppraiser?: typeof createAppraiserFor;
};

/**
 * Builds and starts the service on the shared bootstrap: a failure in any step ends the process with status 1
 * (AFF-HEALTH-002), and `ready` follows the creation of the consumer group (AFF-HEALTH-001).
 */
export async function affectMain(ctx: ServiceContext<AffectBus>, env: AffectEnv = {}): Promise<void> {
  const { cfg, bus, log, heartbeat, onStop } = ctx;
  const exit = env.exit ?? ((code: number) => process.exit(code));
  const appraiser = (env.createAppraiser ?? createAppraiserFor)(cfg, log); // @spec AFF-HOOK-001
  const affect = new Affect({ cfg, bus, appraiser, log, heartbeat });

  // The group must exist before `ready`: bus.subscribe only resolves when stopped, so it cannot be awaited.
  // resetGroup creates a missing group at `$` and moves an existing one there, the same as start mode `latest`.
  await bus.resetGroup("affect");
  void bus.subscribe( // @spec AFF-IN-001
    { group: "affect", types: ["chat.message", "speech.heard", "vision.summary", "brain.say", "control"], start: "latest" },
    (ev) => affect.onEvent(ev),
  ).catch((err) => { log.error({ err }, "fatal"); exit(1); });
  const timer = setInterval(() => affect.publish(), cfg.brain.affect.publish_ms); // @spec AFF-PUB-001
  onStop(() => clearInterval(timer));
  heartbeat.ready();
  log.info({ half_life_ms: cfg.brain.affect.half_life_ms, appraiser: appraiser.kind }, "affect online");
}

/** The service entry: bootstrap, then `affectMain`. */
export function runAffect(env: AffectEnv = {}): Promise<void> { // @spec AFF-HEALTH-001, AFF-HEALTH-002
  const { createAppraiser, ...boot } = env;
  const exit = boot.exit ?? ((code: number) => process.exit(code));
  const log = boot.log ?? createLogger("affect");
  return runService<AffectBus>({
    service: "affect",
    health: (cfg: Config) => affectHealth(cfg),
    main: (ctx) => affectMain(ctx, env),
    ...boot,
    log,
  }).catch((err) => { log.error({ err }, "fatal"); exit(1); }); // a bus that cannot be built is a startup failure too
}
