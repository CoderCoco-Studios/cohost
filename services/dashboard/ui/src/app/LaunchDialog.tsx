import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type SyntheticEvent } from "react";
import { ActionStatus } from "../components/ActionStatus";
import { Button } from "../components/Button";
import { Dialog } from "../components/Dialog";
import { Icon } from "../components/Icon";
import { useFeed, type useMute } from "../state/hooks";
import { ConfirmBars } from "./ConfirmBars";

type Mute = ReturnType<typeof useMute>;
import type { ProgressRow, StackProgress } from "../state/types";
import { KIND_LABEL, outcomeWords, rowStateWords } from "../screens/services/model";

/** What the shell and the stack card need from the launch progress dialog: whether it is open, and a way to reopen it on the kept record. */
export interface LaunchDialogControl { open: boolean; show: () => void }

const Ctx = createContext<LaunchDialogControl>({ open: false, show: () => {} });

/** The launch progress dialog's state, for the stack card's "Last launch: details" link (DASH-UI-063). */
export function useLaunchDialog(): LaunchDialogControl { return useContext(Ctx); }

/** A row whose build or restart has finished: it reads complete, with no step (DASH-UI-055). */
const FINISHED: ReadonlySet<ProgressRow["state"]> = new Set(["built", "cached", "done"]);

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
  const finished = FINISHED.has(r.state);
  const step = !finished && r.step !== undefined && r.of !== undefined ? `step ${r.step} of ${r.of}` : "";
  const count = finished ? "complete" : r.total ? `${r.done ?? 0}/${r.total} steps${r.cached ? `, ${r.cached} cached` : ""}` : "";
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

/** The record's body: the outcome, the rows in their fixed-height region, the failure and the log (DASH-UI-055 to 057, DASH-UI-064). */
function Progress({ p, alert }: { p: StackProgress; alert: boolean }) {
  return (
    <>
      <p className="launch-outcome" tabIndex={-1} data-autofocus><strong>{KIND_LABEL[p.kind]}</strong>{` ${outcomeWords(p)}`}</p>
      <div className="launch-rows">
        <table className="launch-table" aria-label={`${KIND_LABEL[p.kind]} services`}>
          <thead><tr><th scope="col">Service</th><th scope="col">State</th><th scope="col">Step</th><th scope="col">Progress</th></tr></thead>
          <tbody>{p.rows.map((r) => <RowView key={r.service} r={r} />)}</tbody>
        </table>
      </div>
      {p.failure ? (
        <div role={alert ? "alert" : "status"} className="launch-failure">
          <p>{p.failure.service ? <><span className="mono">{p.failure.service}</span>{p.kind === "restart" ? " failed to restart." : " failed to build."}</> : `${KIND_LABEL[p.kind]} failed.`}</p>
          <pre className="launch-pre">{p.failure.lines.join("\n")}</pre>
        </div>
      ) : null}
      {p.lines.length ? <LogPane lines={p.lines} label={p.kind === "restart" ? "Output" : "Build log"} /> : null}
    </>
  );
}

/**
 * The launch progress dialog, owned by the operator shell so it covers every operator screen and survives a change of route
 * (the sink view renders no shell, so never shows it). It is driven by the `stack-progress` record alone: open whenever the
 * record runs, which a page loaded or reloaded mid-action, or another tab, receives on connect; not dismissible until the
 * action ends; then it shows the outcome and closes on request. A record that had ended before this page saw it running opens
 * nothing, but the stack card's link reopens it on the kept record. The failure is an alert only when this page saw the action
 * running and then fail and has not closed it since.
 */
// @spec DASH-UI-055, DASH-UI-056, DASH-UI-057, DASH-UI-060, DASH-UI-061, DASH-UI-062, DASH-UI-063, DASH-UI-064, DASH-UI-069, DASH-UI-070
export function LaunchDialogHost({ mute, children }: { /** The shell's mute state, shared with the header and the `m` shortcut. */ mute: Mute; children?: ReactNode }) {
  const p = useFeed((f) => f.progress);
  const actionStart = useFeed((f) => f.stack?.action?.startedAt);
  const offline = useFeed((f) => f.stoppedAt !== undefined);
  const sawRunning = useRef<number | null>(null);
  const [closed, setClosed] = useState<number | null>(null);
  const [reopened, setReopened] = useState<number | null>(null);
  // Running only while the server still reports the action the record belongs to (DASH-UI-060). This gates opening and
  // dismissal only: the title and outcome follow the record, since at an action's end the `stack` message without the action
  // arrives before the final record, whose `ok` is not known until then.
  const running = p !== null && p.running && actionStart === p.startedAt;
  if (running) sawRunning.current = p.startedAt;
  const key = p?.startedAt ?? null;
  const open = p !== null && (running || reopened === key || (sawRunning.current === key && closed !== key));
  const close = useCallback(() => { setClosed(key); setReopened(null); }, [key]);
  const show = useCallback(() => setReopened(key), [key]);
  const control = useMemo(() => ({ open, show }), [open, show]);
  const alert = p !== null && p.failure !== undefined && !p.running && sawRunning.current === key && reopened !== key;
  const title = p ? `${KIND_LABEL[p.kind]} ${outcomeWords(p)}` : "";
  return (
    <Ctx.Provider value={control}>
      {children}
      <Dialog open={open} title={title} className="launch-dialog" dismissible={!running} muteShortcut onClose={close}
        footer={p && !running ? <Button onClick={close}>Close</Button> : undefined}>
        {offline ? <p className="note note-warn small" role="status">Live updates stopped. What this shows may be out of date until the dashboard reconnects.</p> : null}
        {p ? <Progress p={p} alert={alert} /> : null}
        <div className="row launch-mute">
          <Button aria-pressed={mute.muted} busy={mute.pending} onClick={() => void mute.toggle()}><Icon name="mic" /><span className="btn-text">{mute.label}</span></Button>
          <ActionStatus state={mute.action.state} onDismiss={mute.action.dismiss} />
        </div>
        <ConfirmBars />
      </Dialog>
    </Ctx.Provider>
  );
}

/** The tool confirmation bars between the header and the screen, except while the launch progress dialog holds them (DASH-UI-069). */
export function ShellConfirmBars() {
  return useLaunchDialog().open ? null : <ConfirmBars />;
}
