import {
  ComposeRuntime, ServiceController, isLoopback, loadControlConfig, LOOPBACK_BIND,
  type ControlConfig, type GroupResetter, type LifecycleRecord, type Runtime,
} from "@cohost/control";
import type { Publisher } from "@cohost/bus";
import { findWorkspaceRoot, type Logger } from "@cohost/config";
import type { DashboardDeps } from "./routes.js";

export interface ControlSetup {
  /** Pass to createDashboardHandler: the one lock and the service controller. */
  control: DashboardDeps["control"];
  /** The full-surface listener's address (DASH-CTRL-003). */
  bind: string;
}

const nonEmpty = (v: string | undefined): string | undefined => (v !== undefined && v.trim() !== "" ? v.trim() : undefined);

/**
 * The full-surface address (`DASHBOARD_HOST`, else loopback) and the control configuration, shared by normal mode and config
 * recovery mode. Throws, before any listener is bound, when `CONTROL_TOKEN` is missing or shorter than 32 characters
 * (DASH-CTRL-002); the message names the variable and never its value.
 */
// @spec DASH-CTRL-002, DASH-CTRL-003, CFG-ENV-009
export function fullSurfaceBind(env: NodeJS.ProcessEnv): { bind: string; cfg: ControlConfig } {
  const bind = nonEmpty(env.DASHBOARD_HOST) ?? LOOPBACK_BIND;
  return { bind, cfg: loadControlConfig(env) };
}

// @spec DASH-CTRL-001, DASH-CTRL-002, DASH-CTRL-003, DASH-CTRL-008, CTRL-STACK-001
/**
 * Reads CONTROL_* and DASHBOARD_HOST env and builds the controller, on every run: no variable switches the stack and lifecycle
 * routes off. Throws (so startup fails) when `CONTROL_TOKEN` is missing or too short. `runtime` can be injected for tests.
 */
export function setupControl(
  env: NodeJS.ProcessEnv,
  bus: Publisher & GroupResetter,
  log: Logger,
  runtime?: Runtime,
): ControlSetup {
  const { bind, cfg } = fullSurfaceBind(env);
  if (!isLoopback(bind)) log.warn({ bind }, "the dashboard is bound to a non-loopback address: CONTROL_TOKEN and the session cookie travel in cleartext over plain HTTP; use a reverse proxy or SSH tunnel");
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
  log.info({ runtime: rt.name, bind }, "service control ready");
  return { control: { token: cfg.token, runtime: rt.name, advanced: cfg.advanced, controller }, bind };
}
