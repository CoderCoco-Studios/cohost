import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A throwaway workspace root for tests that build a `ComposeRuntime` or `StackController`: the control plane writes every
 * unit's projection under its working directory before it starts anything (CTRL-RUNTIME-014), so a test must not point it at
 * the real repository.
 */
export const WS = mkdtempSync(join(tmpdir(), "cohost-ws-"));
