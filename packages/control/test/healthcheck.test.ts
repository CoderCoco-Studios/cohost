import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { Bus, type Heartbeat } from "@cohost/bus";
import { isHealthy } from "../src/healthcheck.js";

const rec = (service: string, ageMs: number, state: Heartbeat["data"]["state"] = "ready", now = 1_000_000): Heartbeat => ({
  id: "1", type: "service.heartbeat", ts: now - ageMs, source: service,
  data: { service, instance: "i", pid: 1, version: "0", startedAt: 1, state, deps: {}, mode: "live", intervalMs: 5000 },
});

test("fresh heartbeat is healthy", () => {
  assert.equal(isHealthy("chat", [rec("chat", 2000)], 1_000_000), true);
});

test("silent service (no heartbeat, or older than 3x interval) is unhealthy", () => {
  assert.equal(isHealthy("chat", [], 1_000_000), false);
  assert.equal(isHealthy("chat", [rec("chat", 20_000)], 1_000_000), false);
  assert.equal(isHealthy("chat", [rec("voice", 1000)], 1_000_000), false);
});

test("stopping is unhealthy even when fresh; only the newest heartbeat counts", () => {
  assert.equal(isHealthy("chat", [rec("chat", 1000, "stopping")], 1_000_000), false);
  assert.equal(isHealthy("chat", [rec("chat", 9000, "stopping"), rec("chat", 1000)], 1_000_000), true);
});

const url = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
async function redisUp(): Promise<boolean> {
  const probe = new Bus("hc-probe", undefined, url);
  try {
    await Promise.race([probe.recentHealth(1), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 800))]);
    return true;
  } catch { return false; } finally { probe.stop(); }
}

test("CLI exits 0 for a fresh service and 1 for a silent one (needs Redis)", { skip: !(await redisUp()) && `no Redis at ${url}` }, async () => {
  const bus = new Bus("hc-test", undefined, url);
  const name = `hc-${Date.now()}`;
  await bus.publishHealth({ service: name, instance: "i", pid: 1, version: "0", startedAt: 1, state: "ready", deps: {}, mode: "live", intervalMs: 5000 });
  const run = (svc: string) =>
    spawnSync(process.execPath, [new URL("../dist/healthcheck.js", import.meta.url).pathname, svc], { env: { ...process.env, REDIS_URL: url } }).status;
  assert.equal(run(name), 0);
  assert.equal(run(`${name}-silent`), 1);
  bus.stop();
});
