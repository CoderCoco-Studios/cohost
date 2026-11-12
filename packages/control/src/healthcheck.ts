#!/usr/bin/env node
/**
 * Container healthcheck: `node packages/control/dist/healthcheck.js <service>`.
 * Exits 0 iff the newest heartbeat for the service is younger than
 * 3 x its intervalMs (by the Redis server's clock) and is not `stopping`.
 */
import { Bus, type HeartbeatEvent } from "@cohost/bus";
import { STALE_FACTOR } from "./health.js";

// @spec CTRL-CHECK-001
export function isHealthy(service: string, recent: HeartbeatEvent[], now = Date.now()): boolean {
  const latest = recent.filter((h) => h.data.service === service).at(-1);
  if (!latest || latest.data.state === "stopping") return false;
  return now - latest.ts < STALE_FACTOR * latest.data.intervalMs;
}

/** The part of the bus a check reads. */
export type HealthSource = { recentHealth(count: number): Promise<HeartbeatEvent[]>; serverTime(): Promise<number> };

/** Exit code for `service`: 0 healthy, 1 not (or unreadable). Freshness is judged on the Redis server's clock. */
// @spec CTRL-CHECK-002, CTRL-CHECK-004
export async function checkHealth(service: string, bus: HealthSource): Promise<number> {
  try {
    const [recent, now] = await Promise.all([bus.recentHealth(200), bus.serverTime()]);
    return isHealthy(service, recent, now) ? 0 : 1;
  } catch {
    return 1;
  }
}

// @spec CTRL-CHECK-002
async function main(): Promise<number> {
  const service = process.argv[2];
  if (!service) { console.error("usage: healthcheck <service>"); return 2; }
  const bus = new Bus("healthcheck");
  try {
    return await checkHealth(service, bus);
  } finally {
    bus.stop();
  }
}

if (process.argv[1]?.endsWith("healthcheck.js")) {
  const timer = setTimeout(() => process.exit(1), 4000);
  timer.unref();
  main().then((code) => process.exit(code), () => process.exit(1));
}
