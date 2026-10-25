import {
  ComposeRuntime, ProcessRuntime, ServiceController, isLoopback, loadControlConfig,
  type GroupResetter, type LifecycleRecord, type Runtime,
} from "@cohost/control";
import type { Publisher } from "@cohost/bus";
import type { Logger } from "@cohost/config";
import type { DashboardDeps } from "./routes.js";

export interface ControlSetup {
  /** Pass to createDashboardHandler; undefined when control is disabled. */
  control?: DashboardDeps["control"];
  /** Address to listen on; undefined = Node's default (unchanged behaviour while disabled). */
  bind?: string;
}

/**
 * Reads CONTROL_* env and builds the controller. Throws (so startup fails) when CONTROL_ENABLED=1
 * without CONTROL_TOKEN. `runtime` can be injected for tests.
 */
export function setupControl(
  env: NodeJS.ProcessEnv,
  bus: Publisher & GroupResetter,
  log: Logger,
  runtime?: Runtime,
): ControlSetup {
  const cfg = loadControlConfig(env);
  if (!cfg.enabled) return {};
  if (!isLoopback(cfg.bind)) log.warn({ bind: cfg.bind }, "CONTROL_BIND is not loopback: the bearer token travels in cleartext HTTP; use a reverse proxy/SSH tunnel");
  if (cfg.advanced) log.warn("CONTROL_ADVANCED=1: redis/postgres can be stopped from the dashboard");
  const rt = runtime ?? (cfg.runtime === "process" ? new ProcessRuntime({ mode: cfg.processMode }) : new ComposeRuntime());
  const controller = new ServiceController({
    runtime: rt,
    groups: bus,
    by: "dashboard",
    advanced: cfg.advanced,
    processMode: cfg.processMode,
    audit: async (rec: LifecycleRecord) => {
      try { await bus.publish("service.lifecycle", rec); } catch (err) { log.warn({ err, rec }, "could not publish service.lifecycle"); }
    },
  });
  log.info({ runtime: rt.name, bind: cfg.bind }, "service control ENABLED");
  return { control: { token: cfg.token, runtime: rt.name, advanced: cfg.advanced, controller }, bind: cfg.bind };
}
