import type { Logger } from "@cohost/config";
import type { Heartbeat } from "./lifecycle.js";

export interface IdleOptions {
  heartbeat: Pick<Heartbeat, "ready" | "degraded" | "setMode">;
  log: Pick<Logger, "warn" | "error">;
  /** `off`: configured off (ready, mode off, one warning). `degraded`: something needed is missing (error, then reminders). */
  kind: "off" | "degraded";
  /** Names the missing variable or key; the service's own text. */
  reason: string;
  /** Reminder period of a `degraded` plan, ms (default 60000). */
  warnEveryMs?: number;
}

/**
 * The missing-credentials idle plan: the service stays up with an honest heartbeat. It subscribes to nothing and
 * publishes nothing but the heartbeat; a service that takes test injection while idle subscribes its handler itself.
 */
// @spec SHARED-IDLE-001, SHARED-IDLE-002, SHARED-IDLE-003, SHARED-IDLE-004, SHARED-IDLE-005
export function startIdle({ heartbeat, log, kind, reason, warnEveryMs = 60_000 }: IdleOptions): { stop(): void } {
  let timer: ReturnType<typeof setInterval> | undefined;
  if (kind === "off") {
    log.warn(reason);
    heartbeat.setMode("off");
    heartbeat.ready();
  } else {
    log.error(reason);
    heartbeat.degraded(reason);
    timer = setInterval(() => log.warn(`${reason}; still idle`), warnEveryMs);
  }
  return {
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
