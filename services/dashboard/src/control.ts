import {
  ComposeRuntime, ServiceController, isLoopback, loadControlConfig, LOOPBACK_BIND,
  type GroupResetter, type LifecycleRecord, type Runtime,
} from "@cohost/control";
import type { Publisher } from "@cohost/bus";
import { findWorkspaceRoot, type Logger } from "@cohost/config";
import type { DashboardDeps } from "./routes.js";

export interface ControlSetup {
  /** Pass to createDashboardHandler; undefined when control is disabled. */
  control?: DashboardDeps["control"];
  /** The full-surface listener's address (DASH-CTRL-003). */
  bind: string;
  /** The address is not loopback, so every gated route needs the control token (DASH-CTRL-011). */
  tokenRequired: boolean;
}

const nonEmpty = (v: string | undefined): string | undefined => (v !== undefined && v.trim() !== "" ? v.trim() : undefined);

/**
 * The full-surface address (`DASHBOARD_HOST`, else loopback), the control configuration and whether the control token is
 * required (the address is not loopback: the token is for requests from another machine, DASH-CTRL-011), shared by normal mode
 * and config recovery mode. Throws when control is enabled without a token, and when the address is not loopback while control is off.
 */
// @spec DASH-CTRL-003, DASH-HOST-007, DASH-CTRL-011
export function fullSurfaceBind(env: NodeJS.ProcessEnv): { bind: string; cfg: ReturnType<typeof loadControlConfig>; tokenRequired: boolean } {
  const bind = nonEmpty(env.DASHBOARD_HOST) ?? LOOPBACK_BIND;
  const cfg = loadControlConfig(env);
  const tokenRequired = !isLoopback(bind);
  if (!cfg.enabled && tokenRequired) {
    throw new Error(`DASHBOARD_HOST is ${bind}, which other machines can reach: that needs CONTROL_ENABLED=1 with a CONTROL_TOKEN, so every mutating and viewer route is token-protected`);
  }
  return { bind, cfg, tokenRequired };
}

// @spec DASH-CTRL-001, DASH-CTRL-002, DASH-CTRL-003, DASH-CTRL-008, DASH-HOST-007, CTRL-STACK-001
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
  const { bind, cfg, tokenRequired } = fullSurfaceBind(env);
  if (!cfg.enabled) return { bind, tokenRequired };
  if (tokenRequired) log.warn({ bind }, "the dashboard is bound to a non-loopback address: CONTROL_TOKEN and VIEWERS_TOKEN travel in cleartext over plain HTTP; use a reverse proxy or SSH tunnel");
  if (cfg.advanced) log.warn("CONTROL_ADVANCED=1: redis/postgres can be stopped from the dashboard");
  const rt = runtime ?? new ComposeRuntime({ cwd: findWorkspaceRoot() ?? process.cwd(), warn: (msg) => log.warn(msg) });
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
  return { control: { token: cfg.token, runtime: rt.name, advanced: cfg.advanced, controller }, bind, tokenRequired };
}
