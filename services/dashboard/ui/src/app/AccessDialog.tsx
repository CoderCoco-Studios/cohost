import { Button } from "../components/Button";
import { Dialog } from "../components/Dialog";
import { useAccess } from "../state/hooks";
import { TokenForm } from "./access/TokenForm";
import { TokenPanel } from "./access/TokenPanel";

/**
 * The Access dialog host. A request that needs a token calls `access.ask(kind, action)` and waits; this shows
 * `state.prompt` (naming the action, and saying why when the server rejected the token the page held), checks the token
 * before storing it, then releases the request with `resolvePrompt(true)`; Cancel and Esc release it as locked. With no
 * prompt it shows the Access panel when `state.panelOpen`. It is a modal `<dialog>`: focus moves to the field and returns
 * to the opener, and the feed and the audio sink keep running (DASH-ACC-011).
 */
// @spec DASH-ACC-002, DASH-ACC-008, DASH-ACC-011, DASH-UI-006
export function AccessDialog() {
  const { state, access } = useAccess();
  const prompt = state.prompt;
  if (prompt) {
    const cancel = () => access.resolvePrompt(false);
    return (
      <Dialog key={prompt.kind} open title="Access" onClose={cancel}>
        <TokenForm kind={prompt.kind} action={prompt.action} rejected={prompt.rejected} onStored={() => access.resolvePrompt(true)} onCancel={cancel} />
      </Dialog>
    );
  }
  if (state.panelOpen) {
    return (
      <Dialog open title="Access" onClose={() => access.closePanel()} footer={<Button onClick={() => access.closePanel()}>Done</Button>}>
        <TokenPanel />
      </Dialog>
    );
  }
  return null;
}
