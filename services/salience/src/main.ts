import { Bus, type Publisher } from "@cohost/bus";
import { onShutdown as busOnShutdown, startHeartbeat, type HealthPublisher } from "@cohost/shared";
import { loadConfig as loadCfg, type Config, type Logger } from "@cohost/config";
import { hookHealth, pingHooks } from "@cohost/modules";
import { createScorer as createScorerFor } from "./scoring.js";
import { Salience } from "./salience.js";
import { salienceHealth } from "./health.js";

/** What `main` needs from a Bus; tests pass a fake. */
export type SalienceBus = Publisher & HealthPublisher & Pick<Bus, "subscribe" | "resetGroup" | "stop">;

/** The process-level collaborators `main` builds or calls, injectable so tests can run it without Redis. */
export interface MainEnv {
  loadConfig: () => Config;
  createBus: (log: Logger) => SalienceBus;
  createScorer: typeof createScorerFor;
  onShutdown: (fn: () => void | Promise<void>) => void;
  exit: (code: number) => void;
}

const defaults: MainEnv = {
  loadConfig: loadCfg,
  createBus: (log) => new Bus("salience", log),
  createScorer: createScorerFor,
  onShutdown: (fn) => busOnShutdown(fn),
  exit: (code) => process.exit(code),
};

/**
 * Builds and starts the service. Every startup step runs here, so a failure in any of them logs
 * `fatal` and exits 1 (SAL-HEALTH-003); `ready` follows the creation of the consumer group
 * (SAL-HEALTH-001).
 */
export async function main(log: Logger, over: Partial<MainEnv> = {}): Promise<void> { // @spec SAL-HEALTH-003
  const env = { ...defaults, ...over };
  try {
    const cfg = env.loadConfig();
    const bus = env.createBus(log);
    const scorer = env.createScorer(cfg, log); // @spec SAL-SCORE-007
    const hooks = hookHealth([scorer]); // @spec HOOK-HEALTH-004: mode mock and the scorer hook's dependency
    const heartbeat = startHeartbeat(bus, { ...salienceHealth, ...hooks, log }); // @spec SAL-HEALTH-001
    void pingHooks([scorer], log); // @spec HOOK-HEALTH-005
    const salience = new Salience({ cfg, bus, scorer, log });

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
    ).catch((err) => { log.error({ err }, "fatal"); env.exit(1); });
    const timer = setInterval(() => void salience.tick(), cfg.brain.salience.tick_ms); // @spec SAL-FOCUS-001; tick() logs its own failures
    env.onShutdown(async () => { clearInterval(timer); bus.stop(); });
    heartbeat.ready();
    log.info({ reflexes: salience.reflexes.size, threshold: cfg.brain.salience.speak_threshold, scorer: scorer.kind }, "salience online");
  } catch (err) {
    log.error({ err }, "fatal");
    env.exit(1);
  }
}
