import { useEffect, useId, useRef, useState } from "react";
import { Button } from "../components/Button";
import { useApi, useFeed } from "../state/hooks";
import { argLines, originWords, type PendingConfirm } from "../state/tools";
import { useRuntime } from "./providers";

/**
 * The tool confirmation bars: one per pending `tool.confirm`, in arrival order, between the header and the screen so they
 * show on every screen (DASH-TOOL-003). The tool name, argument keys and values and origin come from the model or a tool
 * server: they are shown as text and nothing is built from them.
 */
// @spec DASH-TOOL-003, DASH-TOOL-004, DASH-TOOL-005, DASH-TOOL-026
export function ConfirmBars() {
  const confirms = useFeed((f) => f.confirms);
  useFeed((f) => f.tick); // re-renders each countdown tick
  const { now } = useRuntime();
  if (confirms.length === 0) return null;
  const at = now();
  return (
    <section className="confirm-bars" aria-label="Tool confirmations" aria-live="polite">
      {confirms.map((c) => <ConfirmBar key={c.id} call={c} seconds={Math.max(0, Math.ceil((c.deadline - at) / 1000))} />)}
    </section>
  );
}

type Phase = "idle" | "sending" | "answered";

/** One pending call: what it is, who asked, the seconds left, Allow and Deny. The bar stays until the call's `tool.result` removes it. */
// @spec DASH-TOOL-003, DASH-TOOL-005, DASH-TOOL-026
function ConfirmBar({ call, seconds }: { call: PendingConfirm; seconds: number }) {
  const api = useApi();
  const heading = useId();
  const [phase, setPhase] = useState<Phase>("idle");
  const [failure, setFailure] = useState<string | undefined>();
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const lines = argLines(call.args);

  // The route needs the control token whether or not control mode is on: with none held the Access dialog is asked first and nothing is sent.
  const answer = async (allow: boolean): Promise<void> => {
    setPhase("sending"); setFailure(undefined);
    const r = await api.post("/tools/answer", { id: call.id, allow }, { auth: "control", action: `${allow ? "Allow" : "Deny"} a tool call` });
    if (!alive.current) return;
    if (r.ok) { setPhase("answered"); return; }
    setPhase("idle");
    if (!r.locked) setFailure(`Could not send your answer: ${r.status === 0 ? r.detail : `${r.status} ${r.detail}`}`);
  };

  return (
    <div className="confirm-bar note" role="group" aria-labelledby={heading} data-confirm={call.id}>
      <div className="confirm-main">
        <p id={heading}><span className="confirm-tool mono">{call.tool}</span>{` wants to run, asked for by ${originWords(call.origin)}.`}</p>
        {call.redacted ? (
          <p className="small note note-warn">Arguments are hidden on this connection. Allow is off, because you cannot see what it would run.</p>
        ) : lines.length > 0 ? (
          <dl className="confirm-args mono small">
            {lines.map((l, i) => <div key={i}><dt>{l.key}</dt>{" "}<dd>{l.text}</dd>{" "}</div>)}
          </dl>
        ) : <p className="small muted">No arguments.</p>}
        {failure ? <div className="action-error" role="alert"><span>{failure}</span></div> : null}
        {phase === "answered" ? <output className="small muted">Answered. Waiting for the result.</output> : null}
      </div>
      <span className="confirm-left small" title="Time left to answer">{` ${seconds}s `}</span>
      <div className="row">
        <Button variant="primary" disabled={phase !== "idle" || call.redacted} onClick={() => void answer(true)}>Allow</Button>
        <Button variant="danger" disabled={phase !== "idle"} onClick={() => void answer(false)}>Deny</Button>
      </div>
    </div>
  );
}
