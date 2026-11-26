import { useEffect, useState } from "react";
import { Button } from "../../components/Button";
import { useAccess, useApi } from "../../state/hooks";
import { SetupSteps } from "./SetupSteps";
import type { TokenKind } from "../../state/types";
import { TokenForm } from "./TokenForm";
import { SETUP_WHY, TOKEN_LABEL, UNLOCKS } from "./text";

function stateText(t: { present: boolean; scope: "tab" | "browser" | null; notSetUp?: boolean }): string {
  if (t.notSetUp) return "Not set up on the server"; // a token kept in this browser means nothing while the server has none
  if (t.present) return `Unlocked · ${t.scope === "browser" ? "this browser" : "this tab"}`;
  return "Locked";
}

function TokenRow({ kind, local }: { kind: TokenKind; /** The dashboard says no control token is needed from this machine. */ local?: boolean }) {
  const { state, access } = useAccess();
  const api = useApi();
  const [changing, setChanging] = useState(false);
  const t = state[kind];
  const label = TOKEN_LABEL[kind];
  return (
    <div role="group" aria-label={label} className="token-row">
      <div className="row"><strong>{label}</strong><span className={`tag ${t.present && !t.notSetUp ? "tag-set" : ""}`}>{stateText(t)}</span></div>
      <p className="help">{UNLOCKS[kind]}</p>
      {local ? <p className="help">No control token is needed from this machine: the dashboard listens on loopback only. The token is for other machines, once DASHBOARD_HOST opens the dashboard to them.</p> : null}
      {kind === "viewers" && t.notSetUp && !changing ? (
        <>
          <p className="help">{SETUP_WHY}</p>
          <SetupSteps>
            <div><Button onClick={() => void api.get("/viewers").then((r) => { if (r.status !== 403) access.markNotSetUp("viewers", false); })}>Check again</Button></div>
          </SetupSteps>
        </>
      ) : null}
      {changing ? (
        <TokenForm kind={kind} onStored={() => setChanging(false)} onCancel={() => setChanging(false)} />
      ) : (
        <div className="row">
          <Button onClick={() => setChanging(true)}>Change token</Button>
          <Button variant="danger" onClick={() => access.lock(kind)} disabled={!t.present}>Lock</Button>
        </div>
      )}
    </div>
  );
}

/**
 * The Access panel: both tokens with their state (Unlocked with its storage scope, Locked, or Not set up on the server),
 * what each unlocks, and Change token and Lock (DASH-ACC-008); when `GET /services/control` says the token is not required
 * (a loopback bind, DASH-CTRL-011), the control token's entry says no token is needed from this machine.
 */
// @spec DASH-ACC-008, DASH-ACC-007
export function TokenPanel() {
  const { state } = useAccess();
  const api = useApi();
  const [local, setLocal] = useState(false);
  useEffect(() => {
    let live = true;
    void api.controlInfo().then((r) => { if (live && r.ok) setLocal(!r.data.tokenRequired); });
    return () => { live = false; };
  }, [api]);
  return (
    <div className="token-panel">
      <TokenRow kind="control" local={local} />
      <TokenRow kind="viewers" />
      {state.memoryOnly ? <p className="help">Storage is blocked in this browser, so tokens are kept in memory and you will be asked again after a reload.</p> : null}
    </div>
  );
}
