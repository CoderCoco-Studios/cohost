import type { ReactNode } from "react";

/**
 * A screen's one `<h1>`. It takes programmatic focus (`tabIndex={-1}`) when the operator navigates to the screen, so a
 * keyboard or screen-reader user lands at its top (DASH-A11Y-005); the shell does the focusing.
 */
export function PageHeading({ children }: { children: ReactNode }) {
  return <h1 className="page-title" tabIndex={-1}>{children}</h1>;
}
