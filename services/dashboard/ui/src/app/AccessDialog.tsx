import { Button } from "../components/Button";
import { Dialog } from "../components/Dialog";
import { useAccess } from "../state/hooks";

/**
 * PLACEHOLDER, replaced by the Access package. The mechanism around it is complete: a request that needs a token calls
 * `access.ask(kind, action)` and waits; this dialog must show `state.prompt` (naming `prompt.action`, and the rejection
 * message when `prompt.rejected`), check a submitted token (DASH-ACC-004), call `access.setToken(...)` then
 * `access.resolvePrompt(true)`, or `access.resolvePrompt(false)` on Cancel. It also shows the panel when
 * `state.panelOpen` (DASH-ACC-008) and closes it with `access.closePanel()`. This stand-in only lets a waiting request
 * be cancelled, so nothing waits forever.
 */
export function AccessDialog() {
  const { state, access } = useAccess();
  const prompt = state.prompt;
  const close = () => { if (prompt) access.resolvePrompt(false); access.closePanel(); };
  return (
    <Dialog open={!!prompt || state.panelOpen} title="Access" onClose={close} footer={<Button onClick={close}>{prompt ? "Cancel" : "Close"}</Button>}>
      <p>{prompt ? `${prompt.action} is waiting for the ${prompt.kind} token.` : "The Access panel is built in its own package."}</p>
    </Dialog>
  );
}
