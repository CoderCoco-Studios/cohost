import { useState } from "react";
import { Button } from "../../components/Button";
import { useAccess, useApi } from "../../state/hooks";
import { SetupSteps } from "./SetupSteps";
import type { TokenKind } from "../../state/types";
import { TokenForm } from "./TokenForm";
import { SETUP_WHY, TOKEN_LABEL, UNLOCKS } from "./text";

function stateText(t: { present: boolean; scope: "tab" | "browser" | null; notSetUp?: boolean }): string {
  if (t.present) return `Unlocked · ${t.scope === "browser" ? "this browser" : "this tab"}`;
  return t.notSetUp ? "Not set up on the server" : "Locked";
}

function TokenRow({ kind }: { kind: TokenKind }) {
  const { state, access } = useAccess();
  const api = useApi();
  const [changing, setChanging] = useState(false);
  const t = state[kind];
  const label = TOKEN_LABEL[kind];
  return (
    <div role="group" aria-label={label} className="token-row">
      <div className="row"><strong>{label}</strong><span className={`tag ${t.present ? "tag-set" : ""}`}>{stateText(t)}</span></div>
      <p className="help">{UNLOCKS[kind]}</p>
      {kind === "viewers" && t.notSetUp && !t.present && !changing ? (
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
 * what each unlocks, and Change token and Lock (DASH-ACC-008).
 */
// @spec DASH-ACC-008, DASH-ACC-007
export function TokenPanel() {
  const { state } = useAccess();
  return (
    <div className="token-panel">
      <TokenRow kind="control" />
      <TokenRow kind="viewers" />
      {state.memoryOnly ? <p className="help">Storage is blocked in this browser, so tokens are kept in memory and you will be asked again after a reload.</p> : null}
    </div>
  );
}
