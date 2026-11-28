import { memo, useState } from "react";
import { ActionStatus } from "../../components/ActionStatus";
import { Button } from "../../components/Button";
import { ConfirmDialog } from "../../components/Dialog";
import { Status } from "../../components/Status";
import { useAction, useApi } from "../../state/hooks";
import type { StackActionKind } from "../../state/types";
import { containerStatus, restartLine, type Container } from "./model";
import { lifecycleResult } from "./ServiceRow";

const NA = "n/a — container only";

export interface InfraRowProps {
  c: Container;
  /** The running stack action's kind, which a container from the previous run is recreated by (DASH-UI-058). */
  action: StackActionKind | undefined;
  /** Whether this container's service may be restarted here: a manifest unit, and for Redis and Postgres advanced control. */
  restartable: boolean;
  /** Why a request cannot be sent now (a stack action runs, Docker is unavailable). */
  blocked: string | undefined;
}

/**
 * One container that sends no heartbeat, under the Services table's Infrastructure group (DASH-UI-065): Docker's state and
 * health (a one-shot reads completed or failed by its exit code, DASH-UI-066), "n/a — container only" where a heartbeat would
 * go (or, while a launch builds, that it is from the previous run, DASH-UI-058), the Docker restart count, and Restart where
 * the control plane restarts the unit (DASH-UI-067).
 */
// @spec DASH-UI-058, DASH-UI-065, DASH-UI-066, DASH-UI-067
export const InfraRow = memo(function InfraRow({ c, action, restartable, blocked }: InfraRowProps) {
  const api = useApi();
  const act = useAction();
  const [asking, setAsking] = useState(false);
  const id = c.service;
  const info = containerStatus(c);
  const pending = act.state.kind === "pending";
  const why = c.stale ? `from the previous run, recreated by this ${action === "rebuild" ? "rebuild" : "launch"}` : NA;
  const send = async () => {
    const r = await act.run(async () => lifecycleResult(await api.lifecycle(id, "restart", undefined, `Restart ${id}`)), `Restarted ${id}`);
    if (r.ok) setAsking(false);
  };
  const dialogError = asking && act.state.kind === "error" ? act.state.message : undefined;
  return (
    <tr className="svc-row svc-infra">
      <th scope="row" className="svc-name"><span className="mono wrap">{id}</span></th>
      <td data-label="State"><div className="svc-state"><Status status={info.status} label={info.word} /></div></td>
      <td data-label="Why"><span className="small muted">{why}</span></td>
      <td data-label="Last seen">
        <span className="svc-age small muted">{NA}</span>
        <span className="svc-restarts small muted">{restartLine({ containerRestarts: c.restartCount })}</span>
      </td>
      <td data-label="Actions">
        {restartable ? (
          <div className="svc-actions">
            <div className="row">
              <Button size="sm" aria-label={`Restart ${id}`} disabled={pending} onClick={() => { act.dismiss(); setAsking(true); }}>Restart</Button>
            </div>
            {pending ? <span className="small muted">Restarting…</span> : null}
            <ActionStatus state={dialogError !== undefined ? { kind: "idle" } : act.state} onDismiss={act.dismiss} />
            <ConfirmDialog open={asking} title={`Restart ${id}?`} confirmLabel={`Restart ${id}`} disabledReason={blocked} busy={pending} error={dialogError}
              onConfirm={() => void send()} onCancel={() => setAsking(false)}>
              <p>{`The ${id} container restarts. Services that use it may report it down until it is back.`}</p>
            </ConfirmDialog>
          </div>
        ) : null}
      </td>
    </tr>
  );
});
