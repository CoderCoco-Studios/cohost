import type { ReactNode } from "react";
import { CopyCommand } from "./CopyCommand";
import { CONTROL_LINE } from "./text";

/**
 * The steps that set up the dashboard's one token when it was started without one: add the line to `.env`, restart the
 * dashboard, open the unlock link it prints (DASH-ACC-009). It has no field: there is nothing to paste until the server has
 * the token. `children` holds the action that follows, such as the Viewers screen's Check again.
 */
// @spec DASH-ACC-009
export function SetupSteps({ children }: { children?: ReactNode }) {
  return (
    <div className="setup-steps">
      <ol>
        <li>Add this line to <code>.env</code> in the cohost folder. It writes a new random secret as <code>CONTROL_TOKEN</code>.<CopyCommand text={CONTROL_LINE} /></li>
        <li>Restart the dashboard so it reads the new value. It reads <code>.env</code> only when it starts.</li>
        <li>Open the unlock link the dashboard prints in its terminal. It unlocks this browser.</li>
      </ol>
      {children}
    </div>
  );
}
