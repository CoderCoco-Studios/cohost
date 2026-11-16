import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import type { Runtime } from "../state/runtime";

const RuntimeContext = createContext<Runtime | null>(null);

/**
 * Provides the runtime (access, api, feed, theme, audio) to the tree and starts the `/ws` feed while mounted.
 * Tests wrap a screen in this with a runtime built from fakes (`test/ui/helpers/render.tsx`, `renderApp`).
 */
export function AppProviders({ runtime, children, startFeed = true }: { runtime: Runtime; children: ReactNode; startFeed?: boolean }) {
  useEffect(() => {
    if (!startFeed) return;
    runtime.feed.start();
    return () => runtime.feed.stop();
  }, [runtime, startFeed]);
  return <RuntimeContext.Provider value={useMemo(() => runtime, [runtime])}>{children}</RuntimeContext.Provider>;
}

export function useRuntime(): Runtime {
  const rt = useContext(RuntimeContext);
  if (!rt) throw new Error("useRuntime must be used inside <AppProviders>");
  return rt;
}
