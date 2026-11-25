import { findWorkspaceRoot, projectSecrets } from "@cohost/config";
import { SERVICE_MANIFEST, type ServiceDef } from "./manifest.js";

/** The workspace root the projection writes under: `cwd` when the caller has one, else the repository root, else the process cwd. */
export const projectionRoot = (cwd?: string): string => cwd ?? findWorkspaceRoot() ?? process.cwd();

/**
 * Projects the operator's `secrets/secrets.yaml` into one file per unit under `secrets/units/<composeName>/`, from each manifest
 * unit's `secrets` list (config CFG-SEC-019, deployment DEPLOY-SECRET-003). Resolves with nothing, or `{ detail }` holding the
 * failure's message, which names a file, directory or path and never a value.
 */
// @spec CTRL-RUNTIME-014
export async function projectManifestSecrets(root: string, manifest: readonly ServiceDef[] = SERVICE_MANIFEST): Promise<{ detail: string } | undefined> {
  try {
    await projectSecrets(root, manifest.filter((u) => u.secrets.length > 0).map((u) => ({ composeName: u.composeName, secrets: u.secrets })));
    return undefined;
  } catch (err) {
    return { detail: ((err as Error).message || String(err)).slice(0, 500) };
  }
}
