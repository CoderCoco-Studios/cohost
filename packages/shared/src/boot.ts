import { Bus } from "@cohost/bus";
import { createLogger, loadConfig as defaultLoadConfig, unitSettings, type Config, type Logger } from "@cohost/config";
import { onShutdown as defaultOnShutdown, startHeartbeat, type Heartbeat, type HealthPublisher, type HeartbeatSpec } from "./lifecycle.js";
import { receiveCredentials as defaultReceive, type CredentialsReceiver, type ReceivedCredentials } from "./credentials.js";

/** What the bootstrap needs from a bus: it publishes heartbeats and can be stopped. */
export type BootBus = HealthPublisher & { stop(): void | Promise<void> };

/** What `main` receives. */
export interface ServiceContext<B extends BootBus = Bus> {
  cfg: Config;
  bus: B;
  log: Logger;
  heartbeat: Heartbeat;
  /** Register a teardown step; steps run in reverse registration order on shutdown. */
  onStop: (fn: () => void | Promise<void>) => void;
  /** The unit's state key (settings-store STORE-STATE-001), for a unit whose manifest entry sets `stateKey`. */
  stateKey?: Buffer;
}

export interface RunServiceOptions<B extends BootBus = Bus> {
  service: string;
  /** The service's heartbeat spec (mode and deps), from config. */
  health: (cfg: Config) => HeartbeatSpec;
  /** The service itself; resolves once it is running. It calls `heartbeat.ready()` or an idle plan itself. */
  main: (ctx: ServiceContext<B>) => Promise<void>;
  /**
   * Supplies the configuration instead of `loadConfig({ credentials, unit })`, given the received credentials: the dashboard
   * hands over the one it read itself (DASH-HTTP-016), a test its fixture. A replaced loader supplies the credentials too, so the
   * receiver then defaults to none.
   */
  loadConfig?: (credentials: Readonly<Record<string, string>>) => Config;
  /** Replaces `receiveCredentials` (SHARED-BOOT-008, SHARED-BOOT-010). */
  receiveCredentials?: CredentialsReceiver;
  // Replacements for tests: no Redis, no signal handling, no process exit.
  createBus?: (service: string, log: Logger) => B;
  onShutdown?: (fn: () => void | Promise<void>, log?: Logger) => void;
  exit?: (code: number) => void;
  log?: Logger;
  /** Time allowed to all `onStop` steps together, ms (default 5000). */
  stopTimeoutMs?: number;
}

/** The heartbeat detail while a service waits for its credentials message (settings-store STORE-DLV-004). */
export const WAITING_FOR_CREDENTIALS = "waiting for credentials";


/** Whether `service`'s unit gets a credentials message: its manifest entry declares a secret path or a state key (STORE-DLV-002). */
export function getsCredentials(service: string): boolean {
  const u = unitSettings(service);
  return u !== undefined && (u.secrets.length > 0 || u.stateKey);
}

/**
 * The one entry of every service. A unit that gets no credentials message: logger, configuration, bus, heartbeat in
 * `starting`, then `main` (SHARED-BOOT-001). A unit that gets one: logger, bus, heartbeat `starting` with the detail
 * `waiting for credentials`, the message, the configuration with the received credentials, the heartbeat's health from it,
 * then `main` (SHARED-BOOT-009). A configuration that does not load, or a `main` that throws, ends the process with status 1;
 * SIGINT and SIGTERM run the teardown steps (5 s in all) and stop the bus, while waiting too. It never declares readiness.
 */
// @spec SHARED-BOOT-001, SHARED-BOOT-002, SHARED-BOOT-003, SHARED-BOOT-004, SHARED-BOOT-005, SHARED-BOOT-006, SHARED-BOOT-007, SHARED-BOOT-008, SHARED-BOOT-009, SHARED-BOOT-011, STORE-DLV-004
export async function runService<B extends BootBus = Bus>(opts: RunServiceOptions<B>): Promise<void> {
  const { service, health, main } = opts;
  const log = opts.log ?? createLogger(service);
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const registerShutdown = opts.onShutdown ?? defaultOnShutdown;
  const stopTimeoutMs = opts.stopTimeoutMs ?? 5000;
  const load = opts.loadConfig ?? ((credentials: Readonly<Record<string, string>>) => defaultLoadConfig({ credentials, unit: service }));
  const makeBus = opts.createBus ?? ((s: string, l: Logger) => new Bus(s, l) as unknown as B);

  const steps: (() => void | Promise<void>)[] = [];
  let shuttingDown = false;
  const onStop = (fn: () => void | Promise<void>): void => {
    if (!shuttingDown) steps.push(fn);
  };
  const waiting = new AbortController();
  const shutdownWith = (bus: B): void => registerShutdown(async () => {
    shuttingDown = true;
    waiting.abort(new Error("shutting down while waiting for credentials"));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const teardown = (async () => {
      for (const step of [...steps].toReversed()) {
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

  let cfg: Config;
  let bus: B;
  let heartbeat: Heartbeat;
  let stateKey: Buffer | undefined;

  // A replaced loader with no replaced receiver supplies the credentials itself: nothing is delivered, so nothing is waited for.
  const waits = getsCredentials(service) && (opts.receiveCredentials !== undefined || opts.loadConfig === undefined);
  if (!waits) {
    try {
      cfg = load({});
    } catch (err) {
      log.error(err instanceof Error ? err.message : String(err));
      exit(1);
      return;
    }
    bus = makeBus(service, log);
    heartbeat = startHeartbeat(bus, { ...health(cfg), service, log });
    shutdownWith(bus);
  } else {
    bus = makeBus(service, log);
    let spec: HeartbeatSpec | undefined;
    const resolve = <T>(v: T | (() => T)): T => (typeof v === "function" ? (v as () => T)() : v);
    heartbeat = startHeartbeat(bus, {
      service, log, detail: WAITING_FOR_CREDENTIALS,
      mode: () => (spec ? resolve(spec.mode) : "live"),
      deps: () => (spec ? resolve(spec.deps) : {}),
    });
    shutdownWith(bus);
    const fail = async (message: string): Promise<void> => {
      log.error(message);
      await heartbeat.stop();
      await bus.stop();
      exit(1);
    };
    let received: ReceivedCredentials;
    try {
      const receive = opts.receiveCredentials ?? defaultReceive;
      received = await receive(service, { signal: waiting.signal, log });
    } catch (err) {
      if (waiting.signal.aborted) return; // a shutdown signal arrived while waiting: the shutdown sequence ends the process
      await fail(err instanceof Error ? err.message : String(err));
      return;
    }
    if (shuttingDown) return;
    try {
      cfg = load(received.credentials);
    } catch (err) {
      await fail(err instanceof Error ? err.message : String(err));
      return;
    }
    spec = health(cfg);
    heartbeat.setDetail(spec.detail);
    stateKey = received.stateKey;
  }

  try {
    await main({ cfg, bus, log, heartbeat, onStop, ...(stateKey ? { stateKey } : {}) });
  } catch (err) {
    log.error({ err }, "fatal");
    exit(1);
  }
}
