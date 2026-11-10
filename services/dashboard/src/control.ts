import {
  ComposeRuntime, ServiceController, isLoopback, loadControlConfig, LOOPBACK_BIND,
  type GroupResetter, type LifecycleRecord, type Runtime,
} from "@cohost/control";
import type { Publisher } from "@cohost/bus";
import type { Logger } from "@cohost/config";
import type { DashboardDeps } from "./routes.js";

export interface ControlSetup {
  /** Pass to createDashboardHandler; undefined when control is disabled. */
  control?: DashboardDeps["control"];
  /** The full-surface listener's address (DASH-CTRL-003). */
  bind: string;
}

const nonEmpty = (v: string | undefined): string | undefined => (v !== undefined && v.trim() !== "" ? v.trim() : undefined);

// @spec DASH-CTRL-001, DASH-CTRL-002, DASH-CTRL-003, DASH-CTRL-008, DASH-HOST-007
/**
 * Reads CONTROL_* and DASHBOARD_HOST env and builds the controller. Throws (so startup fails) when CONTROL_ENABLED=1
 * without CONTROL_TOKEN, and when the full surface would be reachable from another machine without control mode.
 * `runtime` can be injected for tests.
 */
export function setupControl(
  env: NodeJS.ProcessEnv,
  bus: Publisher & GroupResetter,
  log: Logger,
  runtime?: Runtime,
): ControlSetup {
  const bind = nonEmpty(env.DASHBOARD_HOST) ?? nonEmpty(env.CONTROL_BIND) ?? LOOPBACK_BIND;
  const cfg = loadControlConfig(env);
  if (!cfg.enabled) {
    if (!isLoopback(bind)) {
      throw new Error(`DASHBOARD_HOST (or CONTROL_BIND) is ${bind}, which other machines can reach: that needs CONTROL_ENABLED=1 with a CONTROL_TOKEN, so every stack, lifecycle and viewer route is token-protected`);
    }
    return { bind };
  }
  if (!isLoopback(bind)) log.warn({ bind }, "the dashboard is bound to a non-loopback address: CONTROL_TOKEN and VIEWERS_TOKEN travel in cleartext over plain HTTP; use a reverse proxy or SSH tunnel");
  if (cfg.advanced) log.warn("CONTROL_ADVANCED=1: redis/postgres can be stopped from the dashboard");
  const rt = runtime ?? new ComposeRuntime();
  const controller = new ServiceController({
    runtime: rt,
    groups: bus,
    by: "dashboard",
    advanced: cfg.advanced,
    // @spec DASH-SVC-004
    audit: async (rec: LifecycleRecord) => {
      try { await bus.publish("service.lifecycle", rec); } catch (err) { log.warn({ err, rec }, "could not publish service.lifecycle"); }
    },
  });
  log.info({ runtime: rt.name, bind }, "service control ENABLED");
  return { control: { token: cfg.token, runtime: rt.name, advanced: cfg.advanced, controller }, bind };
}
