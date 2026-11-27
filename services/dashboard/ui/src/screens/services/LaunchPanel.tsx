import { useLayoutEffect, useRef, type SyntheticEvent } from "react";
import { useFeed } from "../../state/hooks";
import type { ProgressRow, StackProgress } from "../../state/types";
import { KIND_LABEL, outcomeWords, rowStateWords } from "./model";

/**
 * The kept output in a collapsed disclosure, following its last line while the reader is at the bottom: on new lines and when
 * the pane is opened, since a closed pane cannot scroll (DASH-UI-057).
 */
function LogPane({ lines, label }: { lines: string[]; label: string }) {
  const ref = useRef<HTMLPreElement>(null);
  const atBottom = useRef(true);
  const follow = () => {
    const el = ref.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  };
  useLayoutEffect(follow, [lines]);
  const onScroll = () => {
    const el = ref.current;
    if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
  };
  const onToggle = (e: SyntheticEvent<HTMLDetailsElement>) => { if (e.currentTarget.open) follow(); };
  return (
    <details className="launch-log" onToggle={onToggle}>
      <summary>{`${label} (${lines.length} ${lines.length === 1 ? "line" : "lines"})`}</summary>
      <pre ref={ref} className="launch-pre" tabIndex={0} aria-label={`${label}, last lines`} onScroll={onScroll}>{lines.join("\n")}</pre>
    </details>
  );
}

function RowView({ r }: { r: ProgressRow }) {
  const step = r.step !== undefined && r.of !== undefined ? `step ${r.step} of ${r.of}` : "";
  const count = r.total ? `${r.done ?? 0}/${r.total} steps${r.cached ? `, ${r.cached} cached` : ""}` : "";
  return (
    <tr className={r.state === "failed" ? "launch-row svc-attn" : "launch-row"}>
      <th scope="row"><span className="mono">{r.service}</span></th>
      <td><span className={`launch-st launch-st-${r.state}`}>{rowStateWords(r.state)}</span></td>
      <td>
        <div className="launch-step">
          {step ? <span>{step}</span> : null}
          {r.current && r.state === "building" ? <span className="mono small muted launch-current" title={r.current}>{r.current}</span> : null}
          {r.detail ? <span className="small">{r.detail}</span> : null}
        </div>
      </td>
      <td className="small muted">{count}</td>
    </tr>
  );
}

/**
 * The Launch panel: the last launch, rebuild or restart-all from the `stack-progress` record, with a row per service,
 * the failure inline and the kept output in a collapsed log pane. Status only: it has no controls (DASH-UI-055 to 057).
 * The failure is an alert only when this page saw the action running and then fail; a failure the page finds on connect,
 * or keeps showing afterwards, is a plain status.
 */
// @spec DASH-UI-055, DASH-UI-056, DASH-UI-057
export function LaunchPanel() {
  const p: StackProgress | null = useFeed((f) => f.progress);
  const sawRunning = useRef<number | null>(null);
  if (!p) return null;
  if (p.running) sawRunning.current = p.startedAt;
  const alert = p.failure !== undefined && !p.running && sawRunning.current === p.startedAt;
  const label = `Launch progress: ${KIND_LABEL[p.kind]} ${outcomeWords(p)}`;
  return (
    <div role="group" aria-label={label} className="launch-panel">
      <p><strong>{KIND_LABEL[p.kind]}</strong>{` ${outcomeWords(p)}`}</p>
      {p.failure ? (
        <div role={alert ? "alert" : "status"} className="launch-failure">
          <p>{p.failure.service ? <><span className="mono">{p.failure.service}</span>{p.kind === "restart" ? " failed to restart." : " failed to build."}</> : `${KIND_LABEL[p.kind]} failed.`}</p>
          <pre className="launch-pre">{p.failure.lines.join("\n")}</pre>
        </div>
      ) : null}
      {p.rows.length ? (
        <div className="svc-scroll">
          <table className="launch-table" aria-label={`${KIND_LABEL[p.kind]} services`}>
            <thead><tr><th scope="col">Service</th><th scope="col">State</th><th scope="col">Step</th><th scope="col">Progress</th></tr></thead>
            <tbody>{p.rows.map((r) => <RowView key={r.service} r={r} />)}</tbody>
          </table>
        </div>
      ) : null}
      {p.lines.length ? <LogPane lines={p.lines} label={p.kind === "restart" ? "Output" : "Build log"} /> : null}
    </div>
  );
}
