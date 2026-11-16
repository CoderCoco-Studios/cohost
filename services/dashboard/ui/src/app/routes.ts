import { useCallback, useSyncExternalStore } from "react";

export type ViewId = "live" | "services" | "viewers" | "settings";
const VIEWS: readonly ViewId[] = ["live", "services", "viewers", "settings"];

/** The current view; `section` is the settings section path (`#settings/brain.salience`, `#settings/personality`). */
export interface Route { view: ViewId; section?: string }

/** Reads a route from a URL hash. An empty or unknown hash is Live; a section is only meaningful for Settings (DASH-NAV-001). */
// @spec DASH-NAV-001
export function parseHash(hash: string): Route {
  const [head = "", ...rest] = hash.replace(/^#/, "").split("/");
  const view = VIEWS.find((v) => v === head);
  if (!view) return { view: "live" };
  if (view !== "settings" || rest.length === 0) return { view };
  let section = rest.join("/");
  try { section = decodeURIComponent(section); } catch { /* keep the raw text */ }
  return section ? { view, section } : { view };
}

export function formatHash(route: Route): string {
  return `#${route.view}${route.view === "settings" && route.section ? `/${encodeURIComponent(route.section)}` : ""}`;
}

const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  window.addEventListener("hashchange", l);
  return () => { listeners.delete(l); window.removeEventListener("hashchange", l); };
};

/** Moves to a route by setting the hash and telling subscribers at once (the browser's `hashchange` arrives later). */
export function navigate(route: Route): void {
  const hash = formatHash(route);
  if (location.hash !== hash) location.hash = hash;
  for (const l of [...listeners]) l();
}

/**
 * The current route, following the URL hash: back and forward arrive as `hashchange`. Returns `[route, navigate]`.
 * Screens link with `<a href={formatHash({view:"settings", section})}>`; the shell handles the click.
 */
export function useRoute(): [Route, (route: Route) => void] {
  const hash = useSyncExternalStore(subscribe, () => location.hash, () => "");
  const route = parseHash(hash);
  return [useStableRoute(route), useCallback(navigate, [])];
}

// A parsed route is a new object each render; keep one per distinct view and section so effects keyed on it stay quiet.
let last: Route = { view: "live" };
function useStableRoute(next: Route): Route {
  if (last.view !== next.view || last.section !== next.section) last = next;
  return last;
}
