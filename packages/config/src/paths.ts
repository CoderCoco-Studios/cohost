import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ISOLATION_ENV } from "./pipeline.js";

/**
 * Walk up from `start` to the nearest dir containing pnpm-workspace.yaml.
 * The `dev:<service>` mise tasks and the memory one-shots run with cwd set to the package dir, so cwd alone isn't the repo root.
 */
export function findWorkspaceRoot(start = process.cwd()): string | undefined {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

// @spec CFG-DIR-001, CFG-DIR-002
export const configDir = (): string =>
  resolve(process.env.CONFIG_DIR ?? join(findWorkspaceRoot() ?? process.cwd(), "config"));

/**
 * Where services keep generated files they must remember across restarts: `COHOST_DATA_DIR`, else `data` under the
 * workspace root (cwd when there is none). Each service writes only under `<dataDir()>/<service>/`.
 */
// @spec CFG-DIR-006, CFG-DIR-007
export const dataDir = (): string =>
  resolve(process.env.COHOST_DATA_DIR ?? join(findWorkspaceRoot() ?? process.cwd(), "data"));

/**
 * Dev convenience: if a .env sits next to the config dir (repo root) and we're
 * not inside compose (which injects env itself), load it without overriding
 * anything already set. Handles `KEY=value`, `KEY="quoted value"`, comments.
 */
// @spec CFG-ENV-010
export const dotEnvPath = (): string =>
  process.env.COHOST_ENV_FILE || join(findWorkspaceRoot() ?? dirname(configDir()), ".env");

// @spec CFG-ENV-004, CFG-ENV-005, CFG-ENV-006, CFG-ISO-008
export function loadDotEnv(file = dotEnvPath()): void {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    const rest = line.slice(eq + 1);
    let val = rest.trim();
    const q = val[0];
    const close = q === '"' || q === "'" ? val.indexOf(q, 1) : -1;
    if (close > 0 && /^\s*(#.*)?$/.test(val.slice(close + 1))) val = val.slice(1, close); // quoted, optionally followed by a comment
    else if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    else val = rest.replace(/\s+#.*$/, "").trim(); // unquoted: whitespace then `#` starts a comment (Compose env_file)
    if (key !== ISOLATION_ENV && process.env[key] === undefined) process.env[key] = val; // only the process itself can carry an override
  }
}
