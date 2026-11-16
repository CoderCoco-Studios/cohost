import { createStore, type Store } from "./store";

export type ThemePreference = "auto" | "light" | "dark";
export interface ThemeState { preference: ThemePreference }

const KEY = "cohost.theme";

export interface Theme {
  state: Store<ThemeState>;
  set(preference: ThemePreference): void;
}

/**
 * The Auto / Light / Dark override (DASH-THEME-002). Auto follows `prefers-color-scheme` through the token stylesheet and
 * leaves `data-theme` off `<html>`; Light and Dark set it and are kept in `localStorage` under `cohost.theme`. The
 * bootstrap script in `index.html` applies a saved choice before first paint. Storage that throws leaves the control
 * working for the page and starting at Auto.
 */
// @spec DASH-THEME-002
export function createTheme(deps: { storage?: Storage; root?: HTMLElement } = {}): Theme {
  const root = deps.root ?? document.documentElement;
  const get = (): string | null => { try { return deps.storage?.getItem(KEY) ?? null; } catch { return null; } };
  const put = (v: string | null): void => { try { if (v === null) deps.storage?.removeItem(KEY); else deps.storage?.setItem(KEY, v); } catch { /* kept for this page only */ } };
  const stored = get();
  const first: ThemePreference = stored === "light" || stored === "dark" ? stored : "auto";
  const apply = (p: ThemePreference): void => { if (p === "auto") delete root.dataset.theme; else root.dataset.theme = p; };
  apply(first);
  const state = createStore<ThemeState>({ preference: first });
  return {
    state,
    set(preference) { apply(preference); put(preference === "auto" ? null : preference); state.set({ preference }); },
  };
}
