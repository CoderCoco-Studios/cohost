// The file name of the build's third-party notices (DASH-AVS-011, DEPLOY-LIC-005). The notices Vite plugin replaces the string
// literal below, as a whole, with the hashed name of the notices file in each entry script. A test, or a build that did not
// replace it, reads the global `__COHOST_NOTICES__` instead.

const BUILT_NOTICES: string = "__COHOST_NOTICES_NAME__";

// @spec DASH-AVS-011
/** The hashed notices file name (`third-party-notices-<hash>.txt`), or undefined when the build did not set it. */
export function noticesFile(): string | undefined {
  if (BUILT_NOTICES.startsWith("third-party-notices-")) return BUILT_NOTICES;
  return (globalThis as { __COHOST_NOTICES__?: string }).__COHOST_NOTICES__;
}
