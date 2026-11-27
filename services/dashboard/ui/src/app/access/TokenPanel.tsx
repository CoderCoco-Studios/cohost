import { useEffect, useState } from "react";
import { Button } from "../../components/Button";
import { useAccess, useApi } from "../../state/hooks";
import { SetupSteps } from "./SetupSteps";
import type { TokenKind } from "../../state/types";
import { TokenForm } from "./TokenForm";
import { SETUP_WHY, TOKEN_LABEL, UNLOCKS } from "./text";

function stateText(t: { present: boolean; scope: "tab" | "browser" | null; notSetUp?: boolean }, session: boolean): string {
  if (t.notSetUp) return "Not set up on the server"; // a token kept in this browser means nothing while the server has none
  if (t.present) return `Unlocked · ${t.scope === "browser" ? "this browser" : "this tab"}`;
  if (session) return "Unlocked (this browser)"; // the unlock link's session cookie (DASH-ACC-008)
  return "Locked";
}

function TokenRow({ kind }: { kind: TokenKind }) {
  const { state, access } = useAccess();
  const api = useApi();
  const [changing, setChanging] = useState(false);
  const t = state[kind];
  const session = kind === "control" && state.unlocked;
  // Lock forgets a held token and, in a browser the unlock link unlocked, ends its session cookie too (DASH-ACC-007, DASH-UNL-008).
  const lock = async (): Promise<void> => {
    access.lock(kind);
    if (session && (await api.post("/unlock/forget")).ok) access.markUnlocked(false);
  };
  const label = TOKEN_LABEL[kind];
  return (
    <div role="group" aria-label={label} className="token-row">
      <div className="row"><strong>{label}</strong><span className={`tag ${(t.present || session) && !t.notSetUp ? "tag-set" : ""}`}>{stateText(t, session)}</span></div>
      <p className="help">{UNLOCKS[kind]}</p>
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
          <Button variant="danger" onClick={() => void lock()} disabled={!t.present && !session}>Lock</Button>
        </div>
      )}
    </div>
  );
}

/**
 * The Access panel: both tokens with their state (Unlocked with its storage scope, Locked, or Not set up on the server),
 * what each unlocks, and Change token and Lock; a browser unlocked by the unlock link shows the control token as "Unlocked (this
 * browser)" (DASH-ACC-008).
 */
// @spec DASH-ACC-008, DASH-ACC-007
export function TokenPanel() {
  const { state, access } = useAccess();
  const api = useApi();
  // Whether this browser is unlocked by the unlock link's session cookie, which the page cannot read (HttpOnly).
  useEffect(() => {
    let live = true;
    void api.controlInfo().then((r) => { if (live && r.ok) access.markUnlocked(r.data.unlocked); });
    return () => { live = false; };
  }, [api, access]);
  return (
    <div className="token-panel">
      <TokenRow kind="control" />
      <TokenRow kind="viewers" />
      {state.memoryOnly ? <p className="help">Storage is blocked in this browser, so tokens are kept in memory and you will be asked again after a reload.</p> : null}
    </div>
  );
}
