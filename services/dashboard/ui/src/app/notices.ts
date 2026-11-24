// The file name of the build's third-party notices (DASH-AVS-011, DEPLOY-LIC-005). The notices Vite plugin replaces the
// constant with the hashed name in each entry script; a test or a page without that build reads the global it sets instead.

declare const __COHOST_NOTICES__: string | undefined;

// @spec DASH-AVS-011
/** The hashed notices file name (`third-party-notices-<hash>.txt`), or undefined when the build did not set it. */
export function noticesFile(): string | undefined {
  if (typeof __COHOST_NOTICES__ !== "undefined") return __COHOST_NOTICES__;
  return (globalThis as { __COHOST_NOTICES__?: string }).__COHOST_NOTICES__;
}
