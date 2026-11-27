import { useLayoutEffect, useRef } from "react";
import { useFeed } from "../../state/hooks";
import type { ProgressRow, StackProgress } from "../../state/types";
import { KIND_LABEL, outcomeWords, rowStateWords } from "./model";

/** The kept output, following its last line while the reader is at the bottom (DASH-UI-057). */
function LogPane({ lines }: { lines: string[] }) {
  const ref = useRef<HTMLPreElement>(null);
  const atBottom = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [lines]);
  const onScroll = () => {
    const el = ref.current;
    if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
  };
  return (
    <details className="launch-log">
      <summary>{`Build log (${lines.length} ${lines.length === 1 ? "line" : "lines"})`}</summary>
      <pre ref={ref} className="launch-pre" tabIndex={0} aria-label="Build log, last lines" onScroll={onScroll}>{lines.join("\n")}</pre>
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
      <td className="launch-step">
        {step ? <span>{step}</span> : null}
        {r.current && r.state === "building" ? <span className="mono small muted launch-current" title={r.current}>{r.current}</span> : null}
        {r.detail ? <span className="small">{r.detail}</span> : null}
      </td>
      <td className="small muted">{count}</td>
    </tr>
  );
}

/**
 * The Launch panel: the last launch, rebuild or restart-all from the `stack-progress` record, with a row per service,
 * the failure inline and the kept output in a collapsed log pane. Status only: it has no controls (DASH-UI-055 to 057).
 */
// @spec DASH-UI-055, DASH-UI-056, DASH-UI-057
export function LaunchPanel() {
  const p: StackProgress | null = useFeed((f) => f.progress);
  if (!p) return null;
  const label = `Launch progress: ${KIND_LABEL[p.kind]} ${outcomeWords(p)}`;
  return (
    <div role="group" aria-label={label} className="launch-panel">
      <p><strong>{KIND_LABEL[p.kind]}</strong>{` ${outcomeWords(p)}`}</p>
      {p.failure ? (
        <div role="alert" className="launch-failure">
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
      {p.lines.length ? <LogPane lines={p.lines} /> : null}
    </div>
  );
}
