/**
 * `node packages/control/dist/project-secrets.js`, run from the repository root: projects the operator's secrets file into
 * one file per unit (CTRL-RUNTIME-015). Exits 0 on success; on failure prints the message to stderr and exits 1. The installer
 * runs it once the workspace is built (deployment DEPLOY-SECRET-006).
 */
// @spec CTRL-RUNTIME-015
import { projectManifestSecrets, projectionRoot } from "./secrets.js";

const failed = await projectManifestSecrets(projectionRoot());
if (failed) {
  console.error(failed.detail);
  process.exit(1);
}
