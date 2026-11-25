import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A throwaway workspace root for tests that build a `ComposeRuntime` or `StackController`: the control plane projects the
 * operator's secrets under its working directory before it starts anything (CTRL-RUNTIME-014), so a test must not point it at
 * the real repository. The operator's file is an absent path inside the workspace, so every projection is an empty mapping.
 */
export const WS = mkdtempSync(join(tmpdir(), "cohost-ws-"));
process.env.COHOST_SECRETS_FILE = join(WS, "secrets", "secrets.yaml");
