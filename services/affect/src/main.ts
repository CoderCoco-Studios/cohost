import { Bus, type Publisher } from "@cohost/bus";
import { onShutdown as busOnShutdown, startHeartbeat, type HealthPublisher } from "@cohost/shared";
import { loadConfig as loadCfg, type Config, type Logger } from "@cohost/config";
import { hookHealth, pingHooks } from "@cohost/modules";
import { createAppraiser as createAppraiserFor } from "./appraise.js";
import { Affect } from "./affect.js";
import { affectHealth } from "./health.js";

/** What `main` needs from a Bus; tests pass a fake. */
export type AffectBus = Publisher & HealthPublisher & Pick<Bus, "subscribe" | "resetGroup" | "stop">;

/** The process-level collaborators `main` builds or calls, injectable so tests can run it without Redis. */
export interface MainEnv {
  loadConfig: () => Config;
  createBus: (log: Logger) => AffectBus;
  createAppraiser: typeof createAppraiserFor;
  onShutdown: (fn: () => void | Promise<void>) => void;
  exit: (code: number) => void;
}

const defaults: MainEnv = {
  loadConfig: loadCfg,
  createBus: (log) => new Bus("affect", log),
  createAppraiser: createAppraiserFor,
  onShutdown: (fn) => busOnShutdown(fn),
  exit: (code) => process.exit(code),
};

/**
 * Builds and starts the service. Every startup step runs here, so a failure in any of them logs
 * `fatal` and exits 1 (AFF-HEALTH-002); `ready` follows the creation of the consumer group
 * (AFF-HEALTH-001).
 */
export async function main(log: Logger, over: Partial<MainEnv> = {}): Promise<void> { // @spec AFF-HEALTH-002
  const env = { ...defaults, ...over };
  try {
    const cfg = env.loadConfig();
    const bus = env.createBus(log);
    const appraiser = env.createAppraiser(cfg, log); // @spec AFF-HOOK-001
    const hooks = hookHealth([appraiser]); // @spec HOOK-HEALTH-004: mode mock and the appraiser hook's dependency
    const heartbeat = startHeartbeat(bus, { ...affectHealth, ...hooks, log }); // @spec AFF-HEALTH-001
    void pingHooks([appraiser], log); // @spec HOOK-HEALTH-005
    const affect = new Affect({ cfg, bus, appraiser, log });

    // The group must exist before `ready`: bus.subscribe only resolves when stopped, so it cannot be awaited.
    // resetGroup creates a missing group at `$` and moves an existing one there, the same as start mode `latest`.
    await bus.resetGroup("affect");
    void bus.subscribe( // @spec AFF-IN-001
      { group: "affect", types: ["chat.message", "speech.heard", "vision.summary", "brain.say", "control"], start: "latest" },
      (ev) => affect.onEvent(ev),
    ).catch((err) => { log.error({ err }, "fatal"); env.exit(1); });
    const timer = setInterval(() => affect.publish(), cfg.brain.affect.publish_ms); // @spec AFF-PUB-001
    env.onShutdown(async () => { clearInterval(timer); bus.stop(); });
    heartbeat.ready();
    log.info({ half_life_ms: cfg.brain.affect.half_life_ms, appraiser: appraiser.kind }, "affect online");
  } catch (err) {
    log.error({ err }, "fatal");
    env.exit(1);
  }
}
