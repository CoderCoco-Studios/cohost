import { findWorkspaceRoot, loadDotEnv, projectSecrets, type DerivedSecrets } from "@cohost/config";
import { SERVICE_MANIFEST, type ServiceDef } from "./manifest.js";
import { controlTokenProblem, earsListenerKey } from "./config.js";

/** The workspace root the projection writes under: `cwd` when the caller has one, else the repository root, else the process cwd. */
export const projectionRoot = (cwd?: string): string => cwd ?? findWorkspaceRoot() ?? process.cwd();

/** The derived path ears' delivery carries: the listener key (CTRL-RUNTIME-017, config CFG-SEC-020). */
export const EARS_VERIFIER_PATH = "ears.http.verifier";

/**
 * The derived credentials of the projection: the ears listener key under the `ears` unit, when `CONTROL_TOKEN` (from `env`, then
 * `.env` by the loader's rule) is valid; nothing otherwise. The token itself is never handed on.
 */
// @spec CTRL-RUNTIME-017, DEPLOY-SECRET-012
export function derivedSecrets(env: NodeJS.ProcessEnv, manifest: readonly ServiceDef[] = SERVICE_MANIFEST): DerivedSecrets {
  if (env === process.env) loadDotEnv();
  if (controlTokenProblem(env) !== undefined) return {};
  const ears = manifest.find((u) => u.id === "ears");
  return ears ? { [ears.composeName]: { [EARS_VERIFIER_PATH]: earsListenerKey(env.CONTROL_TOKEN!) } } : {};
}

/**
 * Projects the operator's `secrets/secrets.yaml` into one file per unit under `secrets/units/<composeName>/`, from each manifest
 * unit's `secrets` list (config CFG-SEC-019, deployment DEPLOY-SECRET-003), adding the ears listener key derived from
 * `CONTROL_TOKEN` to ears' file alone (CTRL-RUNTIME-017). Resolves with nothing, or `{ detail }` holding the failure's message,
 * which names a file, directory or path and never a value.
 */
// @spec CTRL-RUNTIME-014, CTRL-RUNTIME-017
export async function projectManifestSecrets(root: string, manifest: readonly ServiceDef[] = SERVICE_MANIFEST, env: NodeJS.ProcessEnv = process.env): Promise<{ detail: string } | undefined> {
  try {
    const derived = derivedSecrets(env, manifest);
    await projectSecrets(root, manifest.filter((u) => u.secrets.length > 0 || derived[u.composeName] !== undefined).map((u) => ({ composeName: u.composeName, secrets: u.secrets })), derived);
    return undefined;
  } catch (err) {
    return { detail: ((err as Error).message || String(err)).slice(0, 500) };
  }
}
