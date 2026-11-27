/**
 * The one lock as the dashboard tests use it: a valid `CONTROL_TOKEN` (at least 32 characters, control-plane CTRL-CONFIG-001),
 * the header that carries it, and a `control` dependency for `createDashboardHandler` with a controller a test does not drive.
 */
import type { DashboardDeps } from "../src/routes.js";

export const TOKEN = "s3cret-control-token-0123456789abcdef";
export const AUTH = { authorization: `Bearer ${TOKEN}` } as const;
export const ON = { CONTROL_TOKEN: TOKEN } as const;

/** The `control` dependency of a handler: the token and, unless given, a controller no route of the test reaches. */
export const testControl = (over: Partial<DashboardDeps["control"]> = {}): DashboardDeps["control"] =>
  ({ token: TOKEN, runtime: "compose", advanced: false, controller: {} as never, ...over });
