import { useCallback, useEffect, useMemo, useState } from "react";
import { useStale } from "../../app/connection";
import type { ScreenProps } from "../../app/screens";
import { PageHeading } from "../../components/PageHeading";
import { EmptyState, ErrorState, LoadingState } from "../../components/StateBlocks";
import { useApi, useFeed } from "../../state/hooks";
import { attentionCount } from "../../state/derive";
import { useEgress, type EgressEntry } from "../../state/egress";
import type { ControlInfo, UnitDescriptor } from "../../state/types";
import { blockReason, sortServices } from "./model";
import { ServiceRow } from "./ServiceRow";
import { StackCard } from "./StackCard";
import { TestSheet } from "./TestSheet";

type Loaded =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; control: ControlInfo; units: Map<string, UnitDescriptor> };

/** Reads `GET /services/control` and `GET /services/manifest` together; `reload` repeats both (the error state's Retry). */
function useControlAndManifest(): [Loaded, () => void] {
  const api = useApi();
  const [state, setState] = useState<Loaded>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    setState({ status: "loading" });
    void Promise.all([api.controlInfo(), api.manifest()]).then(([c, m]) => {
      if (!alive) return;
      if (!c.ok) setState({ status: "error", message: `Could not load whether service control is on: ${c.status ? `${c.status} ` : ""}${c.detail}` });
      else if (!m.ok) setState({ status: "error", message: `Could not load the service manifest: ${m.status ? `${m.status} ` : ""}${m.detail}` });
      else setState({ status: "ready", control: c.data, units: new Map((m.data.units ?? []).map((u) => [u.id, u])) });
    });
    return () => { alive = false; };
  }, [api, attempt]);
  return [state, useCallback(() => setAttempt((n) => n + 1), [])];
}

/**
 * The Services screen: the always-visible stack card, then the service list as a real table (one row per service, keyed
 * by name, needing-attention rows first) with the lifecycle, pause and Test actions of the manifest's units where control
 * is on, and the per-unit test side sheet. Loading, empty, error and stale (socket closed) states follow the design.
 */
// @spec DASH-UI-007, DASH-UI-021, DASH-UI-025, DASH-UI-029, DASH-UI-030, DASH-UI-031, DASH-UI-032, DASH-UI-001
export function Screen(_props: ScreenProps) {
  const [load, reload] = useControlAndManifest();
  const services = useFeed((f) => f.services);
  const stack = useFeed((f) => f.stack);
  const stale = useStale();
  const [testing, setTesting] = useState<string | null>(null);
  const controlOn = load.status === "ready" && load.control.enabled;
  const controlOff = load.status === "ready" && !load.control.enabled;
  const blocked = blockReason(stack);
  const rows = useMemo(() => (services ? sortServices(services) : null), [services]);
  const attention = attentionCount(services);
  const overrides = useMemo(() => new Map((stack?.services ?? []).map((c) => [c.service, Object.entries(c.overrides ?? {}).map(([k, v]) => `${k}=${v}`).join(", ")])), [stack]);
  const onTest = useCallback((id: string) => setTesting(id), []);
  const egress = useEgress();
  const egressBy = useMemo(() => {
    const by = new Map<string, EgressEntry[]>();
    for (const e of egress) if (e.offLan) by.set(e.service, [...(by.get(e.service) ?? []), e]);
    return by;
  }, [egress]);
  const sheetUnit = testing && load.status === "ready" ? load.units.get(testing) : undefined;

  return (
    <>
      <PageHeading>Services</PageHeading>
      <StackCard controlOn={controlOn} controlOff={controlOff} />
      <section {...stale} className={`card${stale.className ? ` ${stale.className}` : ""}`} aria-labelledby="svc-h">
        <div className="card-h">
          <h2 id="svc-h">Services</h2>
          {attention > 0 ? <span className="small muted">{`${attention} ${attention === 1 ? "needs" : "need"} attention`}</span> : null}
          <span className="grow" /><a className="small" href="/cohost/guide/operate/health#the-states" target="_blank" rel="noopener">How to read these states</a>
        </div>
        {load.status === "error" ? <ErrorState message={load.message} onRetry={reload} />
          : services === null || load.status === "loading" ? <LoadingState label="Loading services…" />
          : rows!.length === 0 ? <EmptyState title="No services reported yet">Services appear here once they send their first heartbeat.</EmptyState>
          : (
            <div className="svc-scroll">
              <table className="svc-table" aria-label="Services">
                <thead><tr><th scope="col">Service</th><th scope="col">State</th><th scope="col">Why</th><th scope="col">Last seen</th><th scope="col">Actions</th></tr></thead>
                <tbody>
                  {rows!.map((s) => (
                    <ServiceRow key={s.service} s={s} unit={load.units.get(s.service)} controlOn={controlOn} blocked={blocked} isolatedBy={overrides.get(s.service) ?? ""} onTest={onTest} egress={egressBy.get(s.service) ?? []} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </section>
      {sheetUnit ? <TestSheet key={sheetUnit.id} unit={sheetUnit} controlOn={controlOn} blocked={blocked} onClose={() => setTesting(null)} /> : null}
    </>
  );
}
