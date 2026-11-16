import { useState } from "react";
import { ActionStatus } from "../../components/ActionStatus";
import { Button } from "../../components/Button";
import { ConfirmDialog } from "../../components/Dialog";
import { useAction, useApi } from "../../state/hooks";

/**
 * Wipe context: its own card with a danger button. The button opens a confirmation dialog that says what is lost; only its
 * confirm button sends `POST /control {cmd: "forget_context"}`. A failure is shown inside the dialog, which stays open
 * (DASH-UI-028, DASH-UI-015).
 */
// @spec DASH-UI-028, DASH-UI-015
export function WipeCard() {
  const api = useApi();
  const action = useAction();
  const [open, setOpen] = useState(false);
  const failure = action.state.kind === "error" ? action.state.message : undefined;

  const confirm = async () => {
    const r = await action.run(() => api.control({ cmd: "forget_context" }, "Wipe context"), "Context wiped");
    if (r.ok) setOpen(false);
  };
  const cancel = () => { setOpen(false); action.dismiss(); };

  return (
    <section className="card live-wipe" aria-labelledby="live-wipe-h">
      <div className="card-h"><h2 id="live-wipe-h">Wipe context</h2></div>
      <div className="card-b stack-y">
        <p className="muted">The co-host forgets the current conversation. Viewer notes are kept.</p>
        <div className="row">
          <Button variant="danger" onClick={() => { action.dismiss(); setOpen(true); }}>Wipe context</Button>
          <ActionStatus state={open && failure ? { kind: "idle" } : action.state} onDismiss={action.dismiss} />
        </div>
      </div>
      <ConfirmDialog open={open} title="Wipe context?" confirmLabel="Wipe context" danger busy={action.state.kind === "pending"} error={failure}
        onConfirm={() => void confirm()} onCancel={cancel}>
        <p>The co-host forgets the current conversation: what was just said and answered is gone from its short-term context. Viewer notes are kept.</p>
      </ConfirmDialog>
    </section>
  );
}
