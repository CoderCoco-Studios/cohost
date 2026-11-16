import { useState } from "react";
import { useStale } from "../../app/connection";
import { ActionStatus } from "../../components/ActionStatus";
import { Button } from "../../components/Button";
import { ConfirmDialog } from "../../components/Dialog";
import { Status, stackStatus } from "../../components/Status";
import { useAction, useApi, useFeed } from "../../state/hooks";
import type { StackActionKind } from "../../state/types";
import { KIND_LABEL, blockReason, phaseWords, stackCause, stackStep } from "./model";
import { Since } from "./Since";

interface Ask { title: string; body: string; confirm: string; danger?: boolean }

const ASK: Record<StackActionKind, Ask> = {
  launch: { title: "Launch the stack?", body: "This runs docker compose up --build: the service images are rebuilt first from the current code (an unchanged image is a quick cache hit, changed code takes minutes), then it waits for every service to be ready.", confirm: "Launch" },
  rebuild: { title: "Rebuild the stack?", body: "This runs docker compose up --build: the service images are rebuilt first from the current code (many minutes when the code changed), then the stack is brought up.", confirm: "Rebuild" },
  restart: { title: "Restart every running service?", body: "Each running application service restarts in its default mode. Redis and Postgres are left alone.", confirm: "Restart all" },
  stop: { title: "Stop the whole stack?", body: "Every container stops, Redis and Postgres included. Containers, networks and volumes are kept.", confirm: "Stop stack", danger: true },
  consolidate: { title: "Run the consolidation pass?", body: "The viewer-note consolidation pass runs now and can take up to 30 minutes.", confirm: "Run consolidation pass" },
};
const STARTED: Record<StackActionKind, string> = { launch: "Launch started", rebuild: "Rebuild started", restart: "Restart started", stop: "Stop started", consolidate: "Consolidation started" };

/**
 * The stack card, always shown: the stack's state as a status with a sentence of cause, the running action's kind, phase,
 * step and elapsed time, the last result with each not-ready service, the containers that send no heartbeat and, where
 * control is on, the Launch, Restart all, Rebuild and Stop stack buttons (each behind a confirmation dialog) and the
 * consolidation pass offered after a successful stop. A button is disabled while an action runs or Docker is unavailable.
 */
// @spec DASH-UI-017, DASH-UI-018, DASH-UI-019, DASH-UI-020, DASH-UI-029
export function StackCard({ controlOn, controlOff }: { controlOn: boolean; /** Control is known to be off (not merely unknown or failed to load). */ controlOff: boolean }) {
  const api = useApi();
  const stack = useFeed((f) => f.stack);
  const services = useFeed((f) => f.services);
  const stale = useStale();
  const act = useAction();
  const [asking, setAsking] = useState<StackActionKind | null>(null);

  const info = stack ? stackStatus(stack.state) : null;
  const heartbeating = new Set((services ?? []).map((s) => s.service));
  const others = (stack?.services ?? []).filter((c) => !heartbeating.has(c.service));
  const blocked = blockReason(stack);
  const last = stack?.last ?? null;
  const offerConsolidate = controlOn && stack !== null && !stack.action && last !== null && last.kind === "stop" && last.ok;

  const open = (kind: StackActionKind) => { act.dismiss(); setAsking(kind); };
  const submit = async () => {
    if (!asking) return;
    const kind = asking;
    const r = await act.run(() => api.stackAction(kind, `${KIND_LABEL[kind]}`), STARTED[kind]);
    if (r.ok) setAsking(null);
  };
  // While a dialog is open its failure shows inside it; the card shows only a failure that outlived the dialog.
  const shown = asking !== null && act.state.kind === "error" ? { kind: "idle" as const } : act.state;
  const ask = asking ? ASK[asking] : null;

  const button = (kind: StackActionKind, label: string, variant?: "primary" | "danger") => (
    <Button key={kind} size="sm" variant={variant} disabled={blocked !== undefined} onClick={() => open(kind)}>{label}</Button>
  );

  return (
    <>
      <section {...stale} className={`card stack-card${stale.className ? ` ${stale.className}` : ""}`} aria-labelledby="stack-h">
        <div className="card-h">
          <h2 id="stack-h">Stack</h2>
          {info ? <Status status={info.status} label={info.word} /> : null}
        </div>
        <div className="card-b stack-y">
          {stack === null ? <p className="muted">Waiting for the stack status…</p> : (
            <>
              <p>{stackCause(stack).join(" ")}</p>
              {stack.action ? (
                <div role="group" aria-label="Running action" className="note note-build">
                  <strong>{KIND_LABEL[stack.action.kind]}</strong>
                  <span>{" · "}
                    {phaseWords(stack.action.phase)}
                    {stackStep(stack.action.kind, stack.action.phase) ? ` · step ${stackStep(stack.action.kind, stack.action.phase)} of 2` : ""}
                    {" · "}<Since at={stack.action.startedAt} />
                  </span>
                </div>
              ) : null}
              {last ? (
                <div className="stack-last">
                  <p>
                    <strong className={last.ok ? "ok-text" : "bad-text"}>{`${KIND_LABEL[last.kind]} ${last.ok ? "succeeded" : "failed"}`}</strong>
                    {last.detail ? ` · ${last.detail}` : ""}
                    {" · "}<Since at={last.finishedAt} ago />
                  </p>
                  {last.services?.length ? (
                    <ul aria-label="Not ready" className="plain-list">
                      {last.services.map((x) => <li key={x.service}><span className="mono">{x.service}</span> <span className="muted">{x.health ? `${x.status}, ${x.health}` : x.status}</span></li>)}
                    </ul>
                  ) : null}
                </div>
              ) : null}
              {others.length ? (
                <ul aria-label="Other containers" className="plain-list muted small">
                  {others.map((c) => <li key={c.service}>{`${c.service}: ${c.health ? `${c.status}, ${c.health}` : c.status}`}</li>)}
                </ul>
              ) : null}
            </>
          )}
          {controlOff ? (
            <div className="note" role="status" aria-label="Service control is off">
              <strong className="note-title">Service control is off</strong>
              <span>Set <code>CONTROL_ENABLED=1</code> in <code>.env</code> and restart the dashboard to start, stop and restart services from here, or use <code>cohostctl</code> on the host.</span>
            </div>
          ) : null}
          {controlOn && stack !== null ? (
            <div className="row">
              {stack.state === "down" || stack.state === "docker-unavailable"
                ? button("launch", "Launch", "primary")
                : <>{button("restart", "Restart all")}{button("rebuild", "Rebuild")}{button("stop", "Stop stack", "danger")}</>}
              {offerConsolidate ? button("consolidate", "Run consolidation pass") : null}
              <ActionStatus state={shown} onDismiss={act.dismiss} />
            </div>
          ) : null}
        </div>
      </section>
      <ConfirmDialog open={ask !== null} title={ask?.title ?? ""} confirmLabel={ask?.confirm ?? ""} danger={ask?.danger}
        disabledReason={blocked} busy={act.state.kind === "pending"} error={act.state.kind === "error" ? act.state.message : undefined}
        onConfirm={() => void submit()} onCancel={() => setAsking(null)}>
        <p>{ask?.body}</p>
      </ConfirmDialog>
    </>
  );
}
