import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";

export type DockerBin = { ok: true; bin: string } | { ok: false; detail: string };

/** True when `name` is an executable file in a directory of `env.PATH`. */
export function onPathDefault(name: string, env: NodeJS.ProcessEnv): boolean {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, name);
    try {
      if (!statSync(p).isFile()) continue;
      accessSync(p, constants.X_OK);
      return true;
    } catch { /* not in this directory */ }
  }
  return false;
}

export const DOCKER_NOT_FOUND = "Docker not found: neither docker nor docker.exe is on PATH; set COHOST_DOCKER_BIN to the docker executable";

/**
 * The docker executable every Compose command runs: `COHOST_DOCKER_BIN` when set and non-empty, else `docker` when on
 * PATH, else `docker.exe` (the Windows Docker Desktop CLI seen from WSL2). The argv never changes with the binary.
 */
// @spec CTRL-STACK-012
export function resolveDockerBin(env: NodeJS.ProcessEnv, onPath: (name: string, env: NodeJS.ProcessEnv) => boolean = onPathDefault): DockerBin {
  const fixed = env.COHOST_DOCKER_BIN;
  if (fixed !== undefined && fixed !== "") return { ok: true, bin: fixed };
  for (const name of ["docker", "docker.exe"]) if (onPath(name, env)) return { ok: true, bin: name };
  return { ok: false, detail: DOCKER_NOT_FOUND };
}
