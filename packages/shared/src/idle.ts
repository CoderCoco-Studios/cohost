import type { Logger } from "@cohost/config";
import type { Heartbeat } from "./lifecycle.js";

export interface IdleOptions {
  heartbeat: Pick<Heartbeat, "ready" | "degraded" | "setMode">;
  log: Pick<Logger, "warn" | "error">;
  /** `off`: configured off (ready, mode off, one warning). `degraded`: something needed is missing (error, then reminders). */
  kind: "off" | "degraded";
  /** Names the missing variable or key; the service's own text. */
  reason: string;
  /** Delay before a `degraded` plan's first reminder, ms (default 60000); each later delay doubles. */
  warnEveryMs?: number;
  /** Longest delay between reminders, ms (default 3600000, one hour). */
  maxWarnEveryMs?: number;
}

/**
 * The missing-credentials idle plan: the service stays up with an honest heartbeat. It subscribes to nothing and
 * publishes nothing but the heartbeat; a service that takes test injection while idle subscribes its handler itself.
 */
// @spec SHARED-IDLE-001, SHARED-IDLE-002, SHARED-IDLE-003, SHARED-IDLE-004, SHARED-IDLE-005, SHARED-IDLE-006
export function startIdle({ heartbeat, log, kind, reason, warnEveryMs = 60_000, maxWarnEveryMs = 3_600_000 }: IdleOptions): { stop(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  if (kind === "off") {
    log.warn(reason);
    heartbeat.setMode("off");
    heartbeat.ready();
  } else {
    log.error(reason);
    heartbeat.degraded(reason);
    // Reminders back off: warnEveryMs, then double each time up to the cap, so a long outage logs a bounded number of lines.
    const remind = (delay: number) => {
      timer = setTimeout(() => {
        if (stopped) return;
        log.warn(`${reason}; still idle`);
        remind(Math.min(delay * 2, maxWarnEveryMs));
      }, Math.min(delay, maxWarnEveryMs));
    };
    remind(warnEveryMs);
  }
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}
