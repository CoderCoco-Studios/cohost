import type { ReactNode } from "react";
import { CopyCommand } from "./CopyCommand";
import { VIEWERS_LINE } from "./text";

/**
 * The steps that set up the viewers token: add the line to `.env`, restart the dashboard, paste the same value
 * (DASH-ACC-009). It has no field: there is nothing to paste until the server has the token. `children` holds the action
 * that follows, such as the Viewers screen's Check again.
 */
// @spec DASH-ACC-009
export function SetupSteps({ children }: { children?: ReactNode }) {
  return (
    <div className="setup-steps">
      <ol>
        <li>Add this line to <code>.env</code> in the cohost folder. It writes a new random secret; the installer does not generate <code>VIEWERS_TOKEN</code>.<CopyCommand text={VIEWERS_LINE} /></li>
        <li>Restart the dashboard so it reads the new value. It reads <code>.env</code> only when it starts.</li>
        <li>Come back and paste the same value (read it with <code>grep ^VIEWERS_TOKEN= .env</code>).</li>
      </ol>
      {children}
    </div>
  );
}
