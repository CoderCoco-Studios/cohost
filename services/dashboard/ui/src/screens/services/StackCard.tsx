import { useState } from "react";
import { useStale } from "../../app/connection";
import { useLaunchDialog } from "../../app/LaunchDialog";
import { ActionStatus } from "../../components/ActionStatus";
import { Button } from "../../components/Button";
import { ConfirmDialog } from "../../components/Dialog";
import { Status, stackStatus } from "../../components/Status";
import { useAction, useApi, useFeed } from "../../state/hooks";
import type { StackActionKind, StackSnapshot } from "../../state/types";
import { KIND_LABEL, blockReason, healthySummary, phaseWords, stackCause, stackStep } from "./model";
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
const DETAILS: Partial<Record<StackActionKind, string>> = { launch: "Last launch: details", rebuild: "Last rebuild: details", restart: "Last restart all: details" };

type Last = StackSnapshot["last"];
/** The stack action this card sent and that was accepted, with the `last` result shown when it was sent. */
interface Sent { kind: StackActionKind; before: Last }

/** The result of a sent action once a later `last` names its kind: `Launch finished`, `Rebuild failed: <detail>` (DASH-UI-068). */
function outcome(sent: Sent | null, last: Last): string | undefined {
  if (!sent || !last || last.kind !== sent.kind) return undefined;
  const b = sent.before;
  if (b && b.kind === last.kind && b.finishedAt === last.finishedAt && b.ok === last.ok) return undefined; // the result shown when it was sent
  return last.ok ? `${KIND_LABEL[sent.kind]} finished` : `${KIND_LABEL[sent.kind]} failed${last.detail ? `: ${last.detail}` : ""}`;
}

/**
 * The stack card, always shown: the stack's state as a status with a sentence of cause, the running action's kind, phase,
 * step and elapsed time, the last result with each not-ready service, the link that reopens the launch progress dialog, the
 * Launch, Restart all, Rebuild and Stop stack buttons (each behind a confirmation dialog) with the sent action's result, and
 * the consolidation pass offered after a successful stop. A button is disabled while an action runs or Docker is unavailable.
 * The containers that send no heartbeat are rows of the Services table, not listed here (DASH-UI-065).
 */
// @spec DASH-UI-017, DASH-UI-018, DASH-UI-019, DASH-UI-020, DASH-UI-063, DASH-UI-068
export function StackCard() {
  const api = useApi();
  const stack = useFeed((f) => f.stack);
  const services = useFeed((f) => f.services);
  const progress = useFeed((f) => f.progress);
  const launchDialog = useLaunchDialog();
  const stale = useStale();
  const act = useAction();
  const [asking, setAsking] = useState<StackActionKind | null>(null);
  const [sent, setSent] = useState<Sent | null>(null);

  const info = stack ? stackStatus(stack.state) : null;
  const blocked = blockReason(stack);
  const last = stack?.last ?? null;
  const offerConsolidate = stack !== null && !stack.action && last !== null && last.kind === "stop" && last.ok;
  const details = progress && !progress.running ? DETAILS[progress.kind] : undefined;

  const open = (kind: StackActionKind) => { act.dismiss(); setSent(null); setAsking(kind); };
  const submit = async () => {
    if (!asking) return;
    const kind = asking;
    const before = last;
    const r = await act.run(() => api.stackAction(kind, KIND_LABEL[kind]), STARTED[kind]);
    if (r.ok) { setAsking(null); setSent({ kind, before }); }
  };
  // While a dialog is open its failure shows inside it; the card shows only a failure that outlived the dialog.
  const ended = act.state.kind === "ok" ? outcome(sent, last) : undefined;
  const shown = asking !== null && act.state.kind === "error" ? { kind: "idle" as const } : ended ? { kind: "ok" as const, message: ended } : act.state;
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
          {services && services.length > 0 ? <span className="small muted">{healthySummary(services)}</span> : null}
        </div>
        <div className="card-b stack-y">
          {stack === null ? <p className="muted">Waiting for the stack status…</p> : (
            <>
              <p>
                {stackCause(stack).join(" ")}
                {last ? <>{` Last action: ${last.kind} finished `}<Since at={last.finishedAt} words />{`, ${last.ok ? "ok" : `failed${last.detail ? `: ${last.detail}` : ""}`}.`}</> : null}
              </p>
              {stack.action ? (
                <div role="group" aria-label="Running action" className="note note-build">
                  <strong>{KIND_LABEL[stack.action.kind]}</strong>
                  <span>
                    {phaseWords(stack.action.phase)}
                    {stackStep(stack.action.kind, stack.action.phase) ? ` · step ${stackStep(stack.action.kind, stack.action.phase)} of 2` : ""}
                  </span>
                  <span className="small">Started <Since at={stack.action.startedAt} /> ago. Stack actions are locked until this finishes.</span>
                </div>
              ) : null}
              {last?.services?.length ? (
                <div className="stack-last">
                  {last.services?.length ? (
                    <ul aria-label="Not ready" className="plain-list">
                      {last.services.map((x) => <li key={x.service}><span className="mono">{x.service}</span> <span className="muted">{x.health ? `${x.status}, ${x.health}` : x.status}</span></li>)}
                    </ul>
                  ) : null}
                </div>
              ) : null}
              {details ? <p><button type="button" className="link-btn small" onClick={launchDialog.show}>{details}</button></p> : null}
            </>
          )}
          {stack !== null ? (
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
