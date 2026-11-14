import { Bus } from "@cohost/bus";
import { createLogger, loadConfig as defaultLoadConfig, type Config, type Logger } from "@cohost/config";
import { onShutdown as defaultOnShutdown, startHeartbeat, type Heartbeat, type HealthPublisher, type HeartbeatSpec } from "./lifecycle.js";

/** What the bootstrap needs from a bus: it publishes heartbeats and can be stopped. */
export type BootBus = HealthPublisher & { stop(): void | Promise<void> };

/** What `main` receives. */
export interface ServiceContext<B extends BootBus = Bus> {
  cfg: Config;
  bus: B;
  log: Logger;
  heartbeat: Heartbeat;
  /** Register a teardown step; steps run in reverse registration order on shutdown. */
  onStop(fn: () => void | Promise<void>): void;
}

export interface RunServiceOptions<B extends BootBus = Bus> {
  service: string;
  /** The service's heartbeat spec (mode and deps), from config. */
  health: (cfg: Config) => HeartbeatSpec;
  /** The service itself; resolves once it is running. It calls `heartbeat.ready()` or an idle plan itself. */
  main: (ctx: ServiceContext<B>) => Promise<void>;
  // Replacements for tests: no Redis, no signal handling, no process exit.
  loadConfig?: () => Config;
  createBus?: (service: string, log: Logger) => B;
  onShutdown?: (fn: () => void | Promise<void>, log?: Logger) => void;
  exit?: (code: number) => void;
  log?: Logger;
  /** Time allowed to all `onStop` steps together, ms (default 5000). */
  stopTimeoutMs?: number;
}

/**
 * The one entry of every service: logger, configuration, bus, heartbeat in `starting`, then `main`. A config that
 * does not load, or a `main` that throws, ends the process with status 1; SIGINT and SIGTERM run the teardown
 * steps (5 s in all) and stop the bus. It never declares readiness.
 */
// @spec SHARED-BOOT-001, SHARED-BOOT-002, SHARED-BOOT-003, SHARED-BOOT-004, SHARED-BOOT-005, SHARED-BOOT-006, SHARED-BOOT-007, SHARED-BOOT-008
export async function runService<B extends BootBus = Bus>(opts: RunServiceOptions<B>): Promise<void> {
  const { service, health, main } = opts;
  const log = opts.log ?? createLogger(service);
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const registerShutdown = opts.onShutdown ?? defaultOnShutdown;
  const stopTimeoutMs = opts.stopTimeoutMs ?? 5000;

  let cfg: Config;
  try {
    cfg = (opts.loadConfig ?? defaultLoadConfig)();
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    exit(1);
    return;
  }

  const bus = (opts.createBus ?? ((s: string, l: Logger) => new Bus(s, l) as unknown as B))(service, log);
  const heartbeat = startHeartbeat(bus, { ...health(cfg), service, log });

  const steps: (() => void | Promise<void>)[] = [];
  let shuttingDown = false;
  const onStop = (fn: () => void | Promise<void>): void => {
    if (!shuttingDown) steps.push(fn);
  };

  registerShutdown(async () => {
    shuttingDown = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const teardown = (async () => {
      for (const step of [...steps].reverse()) {
        try { await step(); } catch (err) { log.error({ err }, "onStop step failed"); }
      }
    })();
    try {
      await Promise.race([teardown, new Promise<void>((r) => { timer = setTimeout(r, stopTimeoutMs); })]);
    } finally {
      clearTimeout(timer);
      await bus.stop(); // closes the transport after flushing queued acks, at most 2 s (BUS-NAT-ACK-007)
    }
  }, log);

  try {
    await main({ cfg, bus, log, heartbeat, onStop });
  } catch (err) {
    log.error({ err }, "fatal");
    exit(1);
  }
}
