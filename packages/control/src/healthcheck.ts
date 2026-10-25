#!/usr/bin/env node
/**
 * Container healthcheck: `node packages/control/dist/healthcheck.js <service>`.
 * Exits 0 iff the newest heartbeat for the service is younger than
 * 3 x its intervalMs and is not `stopping`.
 */
import { Bus, type Heartbeat } from "@cohost/bus";
import { STALE_FACTOR } from "./health.js";

export function isHealthy(service: string, recent: Heartbeat[], now = Date.now()): boolean {
  const latest = recent.filter((h) => h.data.service === service).at(-1);
  if (!latest || latest.data.state === "stopping") return false;
  return now - latest.ts < STALE_FACTOR * latest.data.intervalMs;
}

async function main(): Promise<number> {
  const service = process.argv[2];
  if (!service) { console.error("usage: healthcheck <service>"); return 2; }
  const bus = new Bus("healthcheck");
  try {
    return isHealthy(service, await bus.recentHealth(200)) ? 0 : 1;
  } finally {
    bus.stop();
  }
}

if (process.argv[1]?.endsWith("healthcheck.js")) {
  const timer = setTimeout(() => process.exit(1), 4000);
  timer.unref();
  main().then((code) => process.exit(code), () => process.exit(1));
}
