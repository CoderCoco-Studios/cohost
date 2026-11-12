import type { Bus, Publisher } from "@cohost/bus";
import { runService, type HealthPublisher, type RunServiceOptions, type ServiceContext } from "@cohost/shared";
import { createLogger, type Config } from "@cohost/config";
import { createScorer as createScorerFor } from "./scoring.js";
import { Salience } from "./salience.js";
import { salienceHealth } from "./health.js";

/** What `main` needs from a Bus; tests pass a fake. */
export type SalienceBus = Publisher & HealthPublisher & Pick<Bus, "subscribe" | "resetGroup" | "stop">;

/** The process-level collaborators of the service, replaceable so a test runs it without Redis, signals or exit. */
export type SalienceEnv = Pick<RunServiceOptions<SalienceBus>, "loadConfig" | "createBus" | "onShutdown" | "exit" | "log" | "stopTimeoutMs"> & {
  createScorer?: typeof createScorerFor;
};

/**
 * Builds and starts the service on the shared bootstrap: a failure in any step ends the process with status 1
 * (SAL-HEALTH-003), and `ready` follows the creation of the consumer group (SAL-HEALTH-001).
 */
export async function salienceMain(ctx: ServiceContext<SalienceBus>, env: SalienceEnv = {}): Promise<void> {
  const { cfg, bus, log, heartbeat, onStop } = ctx;
  const exit = env.exit ?? ((code: number) => process.exit(code));
  const scorer = (env.createScorer ?? createScorerFor)(cfg, log); // @spec SAL-SCORE-007
  const salience = new Salience({ cfg, bus, scorer, log, heartbeat });

  // The group must exist before `ready`: bus.subscribe only resolves when stopped, so it cannot be awaited.
  // resetGroup creates a missing group at `$` and moves an existing one there, the same as start mode `latest`.
  await bus.resetGroup("salience");
  void bus.subscribe( // @spec SAL-IN-001
    {
      group: "salience",
      types: ["chat.message", "speech.heard", "vision.summary", "brain.say", "brain.status", "affect.state", "control"],
      start: "latest",
    },
    (ev) => salience.onEvent(ev),
  ).catch((err) => { log.error({ err }, "fatal"); exit(1); });
  const timer = setInterval(() => void salience.tick(), cfg.brain.salience.tick_ms); // @spec SAL-FOCUS-001; tick() logs its own failures
  onStop(() => clearInterval(timer));
  heartbeat.ready();
  log.info({ reflexes: salience.reflexes.size, threshold: cfg.brain.salience.speak_threshold, scorer: scorer.kind }, "salience online");
}

/** The service entry: bootstrap, then `salienceMain`. */
export function runSalience(env: SalienceEnv = {}): Promise<void> { // @spec SAL-HEALTH-003, SAL-HEALTH-001
  const { createScorer, ...boot } = env;
  const exit = boot.exit ?? ((code: number) => process.exit(code));
  const log = boot.log ?? createLogger("salience");
  return runService<SalienceBus>({
    service: "salience",
    health: (cfg: Config) => salienceHealth(cfg),
    main: (ctx) => salienceMain(ctx, env),
    ...boot,
    log,
  }).catch((err) => { log.error({ err }, "fatal"); exit(1); }); // a bus that cannot be built is a startup failure too
}
