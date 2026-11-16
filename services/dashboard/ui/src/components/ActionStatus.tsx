import type { ActionState } from "../state/hooks";
import { Button } from "./Button";

/**
 * Where a state-changing control reports its outcome (DASH-UI-015, DASH-A11Y-004). A success is text in an `<output>`
 * (a polite live region); a failure is a `role="alert"` with the HTTP status and the server's `detail`, which stays until
 * dismissed or the action is tried again. The `<output>` stays mounted, so a message that appears later is announced.
 * Drive it with `useAction()`: `<ActionStatus state={action.state} onDismiss={action.dismiss} />`.
 */
// @spec DASH-UI-015, DASH-A11Y-004
export function ActionStatus({ state, onDismiss }: { state: ActionState; onDismiss?: () => void }) {
  return (
    <>
      <output className="action-ok small">{state.kind === "ok" ? state.message : ""}</output>
      {state.kind === "error" ? (
        <div className="action-error" role="alert">
          <span>{state.message}</span>
          {onDismiss ? <Button variant="ghost" size="sm" onClick={onDismiss}>Dismiss</Button> : null}
        </div>
      ) : null}
    </>
  );
}
