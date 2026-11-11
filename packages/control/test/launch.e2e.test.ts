import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StackController, resolveDockerBin, defaultExec } from "../src/index.js";

// End to end against a real Docker daemon: StackController.launch and stopAll on a minimal Compose project (one
// health-checked container). The project is private to the test and removed in a finally. Skipped where Docker
// is not usable; CI's compose-smoke job runs it on the runner's Docker (DEPLOY-CI-007).

const env = { ...process.env };
for (const k of ["COMPOSE_FILE", "COMPOSE_PROFILES", "COMPOSE_PROJECT_NAME", "COMPOSE_ENV_FILES"]) delete env[k];

async function dockerUsable(): Promise<string | undefined> {
  const d = resolveDockerBin(env);
  if (!d.ok) return d.detail;
  const run = (args: string[]) => new Promise<boolean>((resolve) => {
    execFile(d.bin, args, { env, timeout: 15_000 }, (err) => resolve(!err));
  });
  if (!(await run(["compose", "version"]))) return "docker compose is not available";
  if (!(await run(["info"]))) return "no reachable Docker daemon";
  return undefined;
}
const unusable = await dockerUsable();

const COMPOSE = (name: string) => `name: ${name}
services:
  probe:
    image: redis:7.4.12-alpine
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 1s
      timeout: 3s
      retries: 30
`;

// @spec CTRL-STACK-015
test("launch brings a health-checked container to running and healthy, stopAll stops it", { skip: unusable, timeout: 240_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cohost-e2e-"));
  const project = `cohost-e2e-${process.pid}-${Date.now()}`;
  writeFileSync(join(dir, "docker-compose.yml"), COMPOSE(project));
  const stack = new StackController({ cwd: dir, env });
  const bin = (resolveDockerBin(env) as { bin: string }).bin;
  try {
    const launched = await stack.launch();
    assert.equal(launched.ok, true, launched.detail);
    const probe = launched.services?.find((c) => c.service === "probe");
    assert.equal(probe?.status, "running");
    assert.equal(probe?.health, "healthy");

    const stopped = await stack.stopAll();
    assert.equal(stopped.ok, true, stopped.detail);
    const after = await stack.statusWithRestarts();
    assert.equal(after.docker.ok, true);
    assert.equal(after.services.find((c) => c.service === "probe")?.status, "exited");
    assert.equal(after.services.find((c) => c.service === "probe")?.restartCount, 0);
  } finally {
    await defaultExec(bin, ["compose", "down", "-v", "--remove-orphans"], { env, cwd: dir, timeoutMs: 120_000 }).catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});
