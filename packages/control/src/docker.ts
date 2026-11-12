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

/**
 * The environment to hand a Docker process: for a Windows executable seen from WSL2 (`*.exe`) `WSLENV` names every
 * variable in `extra`, since interop forwards nothing else; otherwise `base` and `extra` merged unchanged.
 */
// @spec CTRL-RUNTIME-012
export function dockerEnv(bin: string, base: NodeJS.ProcessEnv, extra?: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...base, ...extra };
  const names = Object.keys(extra ?? {});
  if (!/\.exe$/i.test(bin) || names.length === 0) return merged;
  const have = (base.WSLENV ?? "").split(":").filter(Boolean);
  const known = new Set(have.map((e) => e.split("/")[0]));
  merged.WSLENV = [...have, ...names.filter((n) => !known.has(n))].join(":");
  return merged;
}
