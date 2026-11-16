import { useState, type FormEvent } from "react";
import { useRuntime } from "../../app/providers";
import { ActionStatus } from "../../components/ActionStatus";
import { Button } from "../../components/Button";
import { TextField } from "../../components/Field";
import { useAction, useApi, useFeed } from "../../state/hooks";
import { useStore } from "../../state/store";

/** The output ids of a comma-separated field: trimmed, blanks dropped. */
export const parseRoute = (text: string): string[] => text.split(",").map((s) => s.trim()).filter(Boolean);

/**
 * Say a line: a text field and a Say button (Enter sends; `/` focuses the field), and a disclosure holding the optional
 * output ids. `POST /control {cmd: "say", text, route?}`; the field clears and "Sent" shows only after a 2xx answer, a
 * failure is an alert with the status and the server's detail and the text stays (DASH-UI-005, -015, -023). The card also
 * says when the line will not be spoken or heard: the co-host is muted, this tab's audio is off, or the bus is unreachable.
 */
// @spec DASH-UI-005, DASH-UI-015, DASH-UI-023, DASH-NAV-003
export function SayCard() {
  const api = useApi();
  const action = useAction();
  const { audio } = useRuntime();
  const audioOn = useStore(audio.state, (s) => s.enabled);
  const muted = useFeed((f) => f.muted);
  const busDown = useFeed((f) => f.stack?.bus === "unreachable");
  const [text, setText] = useState("");
  const [route, setRoute] = useState("");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const line = text.trim();
    if (!line || action.state.kind === "pending") return;
    const ids = parseRoute(route);
    const r = await action.run(() => api.control({ cmd: "say", text: line, ...(ids.length ? { route: ids } : {}) }, "Say a line"), "Sent");
    if (r.ok) setText("");
  };

  return (
    <section className="card live-say" aria-labelledby="live-say-h">
      <div className="card-h"><h2 id="live-say-h">Say a line</h2><span className="grow" /><span className="small faint"><span className="kbd">/</span> to focus</span></div>
      <form className="card-b stack-y" onSubmit={(e) => void submit(e)}>
        <div className="row live-say-row">
          <TextField className="grow" label="Line for the co-host to speak" value={text} onChange={setText} data-shortcut="say" placeholder="Type a line for the co-host to speak" autoComplete="off" />
          <Button variant="primary" type="submit" busy={action.state.kind === "pending"}>Say</Button>
        </div>
        <details>
          <summary>Send to specific outputs</summary>
          <div className="stack-y live-outputs">
            <TextField label="Outputs" value={route} onChange={setRoute} placeholder="file, http" autoComplete="off"
              help="Output ids separated by commas (discord, dryrun, file, http). Leave blank to use every enabled output." />
          </div>
        </details>
        <div className="row">
          <ActionStatus state={action.state} onDismiss={action.dismiss} />
        </div>
        {muted ? <p className="note note-warn">The co-host is muted: the line is not spoken until you unmute (press m).</p> : null}
        {!audioOn ? <p className="help">Audio is off in this tab, so you will not hear the line here. Turn audio on in the header, or listen in the OBS sink.</p> : null}
        {busDown ? <p className="note note-bad">The bus is unreachable: the line cannot be sent until it is back.</p> : null}
      </form>
    </section>
  );
}
