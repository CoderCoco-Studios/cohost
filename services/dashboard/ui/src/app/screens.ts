import type { ComponentType } from "react";
import { Screen as Live } from "../screens/live";
import { Screen as Services } from "../screens/services";
import { Screen as Viewers } from "../screens/viewers";
import { Screen as Settings } from "../screens/settings";
import type { Route, ViewId } from "./routes";

/** What the shell hands every screen: the current route (Settings reads `route.section`). */
export interface ScreenProps { route: Route }

export interface ScreenDefinition {
  id: ViewId;
  /** The nav item's text and the screen's `<h1>`. */
  label: string;
  /** The key that opens it (DASH-NAV-003). */
  shortcut: string;
  Screen: ComponentType<ScreenProps>;
}

/**
 * The screen registry, in nav order. Each screen is one module, `screens/<id>/index.tsx`, that exports `Screen`; the
 * shell routes, focuses and labels it. To add a screen add its id to `ViewId` in `routes.ts` and a row here.
 */
export const SCREENS: readonly ScreenDefinition[] = [
  { id: "live", label: "Live", shortcut: "1", Screen: Live },
  { id: "services", label: "Services", shortcut: "2", Screen: Services },
  { id: "viewers", label: "Viewers", shortcut: "3", Screen: Viewers },
  { id: "settings", label: "Settings", shortcut: "4", Screen: Settings },
];
