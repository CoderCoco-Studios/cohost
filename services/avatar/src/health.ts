import type { HeartbeatSpec } from "@cohost/shared";

/** avatar: `off` with the null driver; otherwise `live` with `driver` ok iff the driver is connected. */
export function avatarHealth(driver: { name: string; connected(): boolean }): HeartbeatSpec { // @spec AVATAR-HEALTH-002, AVATAR-HEALTH-003
  const off = driver.name === "null";
  return {
    service: "avatar",
    mode: off ? "off" : "live",
    deps: () => ({ driver: off ? "n/a" : driver.connected() ? "ok" : "down" }),
  };
}
