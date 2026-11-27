import { useEffect, useState } from "react";
import { Button } from "../../components/Button";
import { useAccess, useApi } from "../../state/hooks";
import type { TokenKind } from "../../state/types";
import { TokenForm } from "./TokenForm";
import { TOKEN_LABEL, UNLOCKS } from "./text";

function stateText(t: { present: boolean; scope: "tab" | "browser" | null }, session: boolean): string {
  if (t.present) return `Unlocked · ${t.scope === "browser" ? "this browser" : "this tab"}`;
  if (session) return "Unlocked (this browser)"; // the unlock link's session cookie (DASH-ACC-008)
  return "Locked";
}

function TokenRow({ kind }: { kind: TokenKind }) {
  const { state, access } = useAccess();
  const api = useApi();
  const [changing, setChanging] = useState(false);
  const t = state[kind];
  const session = state.unlocked;
  // Lock forgets a held token and, in a browser the unlock link unlocked, ends its session cookie too (DASH-ACC-007, DASH-UNL-008).
  const lock = async (): Promise<void> => {
    access.lock(kind);
    if (session && (await api.post("/unlock/forget")).ok) access.markUnlocked(false);
  };
  const label = TOKEN_LABEL[kind];
  return (
    <div role="group" aria-label={label} className="token-row">
      <div className="row"><strong>{label}</strong><span className={`tag ${t.present || session ? "tag-set" : ""}`}>{stateText(t, session)}</span></div>
      <p className="help">{UNLOCKS[kind]}</p>
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
 * The Access panel: the dashboard's one token with its state (Unlocked with its storage scope, Unlocked (this browser) when
 * the unlock link's session cookie unlocked the browser, or Locked), what it unlocks, and Change token and Lock (DASH-ACC-008).
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
      {state.memoryOnly ? <p className="help">Storage is blocked in this browser, so tokens are kept in memory and you will be asked again after a reload.</p> : null}
    </div>
  );
}
