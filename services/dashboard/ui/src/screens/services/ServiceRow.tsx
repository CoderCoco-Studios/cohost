import { memo, useState } from "react";
import { ActionStatus } from "../../components/ActionStatus";
import { Button } from "../../components/Button";
import { ConfirmDialog, Dialog } from "../../components/Dialog";
import { SegmentedGroup } from "../../components/SegmentedGroup";
import { Status, serviceStatus } from "../../components/Status";
import { Switch } from "../../components/Switch";
import { useAction, useApi, useFeed, useFeedClock } from "../../state/hooks";
import { needsAttention } from "../../state/derive";
import type { ApiResult } from "../../state/api";
import type { ServiceHealth, UnitDescriptor } from "../../state/types";
import { egressNote, type EgressEntry } from "../../state/egress";
import { lastSeen, unitTest, whyOf } from "./model";

type Op = "start" | "restart" | "stop";
const ING: Record<Op, string> = { start: "Starting", restart: "Restarting", stop: "Stopping" };
const DONE: Record<Op, string> = { start: "Started", restart: "Restarted", stop: "Stopped" };
const VERB: Record<Op, string> = { start: "Start", restart: "Restart", stop: "Stop" };
const MODES = [{ value: "", label: "Service default" }, { value: "resume", label: "Resume keeping backlog" }, { value: "fresh", label: "Fresh skipping backlog" }];

/** The last-seen text; the one part of a row that changes on the feed clock's tick. */
function Age({ s }: { s: ServiceHealth }) {
  const now = useFeedClock();
  const arrivedAt = useFeed((f) => f.servicesAt);
  return <>{lastSeen(s, arrivedAt, now)}</>;
}

export interface RowProps {
  s: ServiceHealth;
  /** The manifest's descriptor when this service is a manifest unit. */
  unit: UnitDescriptor | undefined;
  controlOn: boolean;
  /** Why a request cannot be sent now (a stack action runs, Docker is unavailable), shown on the dialogs' confirm buttons. */
  blocked: string | undefined;
  /** The isolation overrides the unit's container runs with, as `NAME=value, ...`; empty when none. */
  isolatedBy: string;
  onTest: (id: string) => void;
  /** The off-LAN destinations of this service's entries in `GET /egress`; empty when none. */
  egress: EgressEntry[];
}

/** A 2xx whose body says `ok: false` is a failure. */
function lifecycleResult(r: ApiResult<{ ok: boolean; detail?: string }>): ApiResult<{ ok: boolean; detail?: string }> {
  if (r.ok && r.data && !r.data.ok) return { ok: false, status: r.status, detail: r.data.detail ?? "not done" };
  return r;
}

/**
 * One service row, keyed by the service name by its parent so it is patched in place (DASH-UI-007): the status, the plain
 * why, the last-seen text, and, for a manifest unit, its actions with per-action feedback (DASH-UI-008, DASH-UI-015).
 */
// @spec DASH-UI-007, DASH-UI-008, DASH-UI-035, DASH-UI-037, MOD-PAUSE-001, MOD-PAUSE-002, MOD-PAUSE-003, MOD-LIFE-002
export const ServiceRow = memo(function ServiceRow({ s, unit, controlOn, blocked, isolatedBy, onTest, egress }: RowProps) {
  const api = useApi();
  const act = useAction();
  const [dialog, setDialog] = useState<Op | null>(null);
  const [mode, setMode] = useState("");
  const [isolated, setIsolated] = useState(false);
  const [working, setWorking] = useState("");
  const info = serviceStatus(s);
  const id = s.service;
  const pending = act.state.kind === "pending";
  const paused = s.heartbeat?.detail === "paused";
  const test = unit ? unitTest(unit) : null;
  const why = whyOf(s);
  const running = s.state !== "down" && s.state !== "unknown";

  const open = (op: Op) => { act.dismiss(); setMode(""); setIsolated(false); setDialog(op); };
  const send = async (op: Op) => {
    setWorking(`${ING[op]}…`);
    const body = op === "stop" ? undefined : { ...(mode ? { mode: mode as "resume" | "fresh" } : {}), ...(isolated ? { isolated: true } : {}) };
    const r = await act.run(async () => lifecycleResult(await api.lifecycle(id, op, body, `${VERB[op]} ${id}`)), (d) => `${DONE[op]} ${id}${d?.detail ? ` · ${d.detail}` : ""}`);
    if (r.ok) setDialog(null);
  };
  const pause = (cmd: "pause" | "resume") => { setWorking(cmd === "pause" ? "Pausing…" : "Resuming…"); void act.run(() => api.control({ cmd, target: id }, `${cmd === "pause" ? "Pause" : "Resume"} ${id}`), cmd === "pause" ? "Pause sent" : "Resume sent"); };
  const dialogError = act.state.kind === "error" && dialog !== null ? act.state.message : undefined;
  const rowState = dialogError !== undefined ? { kind: "idle" as const } : act.state;

  return (
    <tr className={needsAttention(s) ? "svc-row svc-attn" : "svc-row"}>
      <th scope="row" className="svc-name"><span className="mono wrap">{id}</span></th>
      <td data-label="State">
        <div className="svc-state">
          <Status status={info.status} label={info.word} />
          {paused ? <span className="tag">Paused</span> : null}
          {isolatedBy ? <span className="tag tag-iso" title={`Overrides: ${isolatedBy}`}>Runs isolated</span> : null}
          {(s.needs ?? []).map((n) => <span key={n.service} className="needs small muted">{`needs ${n.service} (${n.state})`}</span>)}
        </div>
      </td>
      <td data-label="Why">{why.lead ? <span className="small">{why.lead}</span> : null}{why.lead && why.rest ? " " : ""}{why.rest ? <span className="small muted">{why.rest}</span> : null}
        {egress.map((e, i) => { const note = egressNote(e); return note ? <p key={i} className="egress-note small muted">{note}</p> : null; })}
      </td>
      <td data-label="Last seen">
        <span className="svc-age">{id === "dashboard" ? "now" : <Age s={s} />}</span>
        <span className="svc-restarts small muted">{`${s.restarts} ${s.restarts === 1 ? "restart" : "restarts"}${s.containerRestarts ? ` · container restarted ${s.containerRestarts}` : ""}`}</span>
      </td>
      <td data-label="Actions">
        {unit ? (
          <div className="svc-actions">
            <div className="row">
              {controlOn ? (
                <>
                  {running ? (
                    <>
                      <Button size="sm" variant={needsAttention(s) ? "primary" : undefined} aria-label={`Restart ${id}`} disabled={pending} onClick={() => open("restart")}>Restart</Button>
                      <Button size="sm" aria-label={`Stop ${id}`} disabled={pending} onClick={() => open("stop")}>Stop</Button>
                    </>
                  ) : <Button size="sm" variant="primary" aria-label={`Start ${id}`} disabled={pending} onClick={() => open("start")}>Start</Button>}
                  {unit.pause ? (paused
                    ? <Button size="sm" aria-label={`Resume ${id}`} disabled={pending} onClick={() => pause("resume")}>Resume</Button>
                    : <Button size="sm" aria-label={`Pause ${id}`} disabled={pending} onClick={() => pause("pause")}>Pause</Button>) : null}
                </>
              ) : null}
              {test && test.inputs.length > 0 ? <Button size="sm" variant="ghost" aria-label={`Test ${id}`} onClick={() => onTest(id)}>Test</Button> : null}
            </div>
            {pending ? <span className="small muted">{working}</span> : null}
            <ActionStatus state={rowState} onDismiss={act.dismiss} />
          </div>
        ) : null}
        {dialog === "stop" ? (
        <ConfirmDialog open title={`Stop ${id}?`} confirmLabel={`Stop ${id}`} danger disabledReason={blocked} busy={pending} error={dialogError}
          onConfirm={() => void send("stop")} onCancel={() => setDialog(null)}>
          <p>{`${id} stops until it is started again.`}</p>
        </ConfirmDialog>
      ) : dialog ? (
        <Dialog open title={`${VERB[dialog]} ${id}?`} onClose={() => setDialog(null)}
          footer={<><Button onClick={() => setDialog(null)}>Cancel</Button><Button variant="primary" onClick={() => void send(dialog)} disabled={blocked !== undefined} busy={pending}>{`${VERB[dialog]} ${id}`}</Button></>}>
          <SegmentedGroup legend="Backlog" showLegend name={`mode-${id}`} options={MODES} value={mode} onChange={setMode} />
          <Switch label="Isolated: only this service, with mock or off backends" checked={isolated} onChange={setIsolated} />
          {blocked ? <p className="help">{blocked}</p> : null}
          {dialogError ? <p className="action-error" role="alert">{dialogError}</p> : null}
        </Dialog>
      ) : null}
      </td>
    </tr>
  );
});
