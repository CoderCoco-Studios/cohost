import type { Config } from "@cohost/config";
import type { HeartbeatSpec } from "@cohost/shared";

/**
 * avatar: `off` with the null driver; otherwise `live` with `driver` ok iff the driver is connected. The driver is
 * created inside the service's `main`, after the heartbeat starts, so it is read through `driver()`; until it exists
 * a real driver reads as `down`.
 */
export function avatarHealth(cfg: Config, driver: () => { name: string; connected(): boolean } | undefined): HeartbeatSpec { // @spec AVATAR-HEALTH-002, AVATAR-HEALTH-003
  const off = cfg.avatar.driver === "null";
  return {
    service: "avatar",
    mode: off ? "off" : "live",
    deps: () => ({ driver: off ? "n/a" : driver()?.connected() ? "ok" : "down" }),
  };
}
