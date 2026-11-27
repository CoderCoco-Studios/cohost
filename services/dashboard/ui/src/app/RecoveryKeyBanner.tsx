import { useEffect, useState } from "react";
import { Banner } from "../components/Banner";
import { Button } from "../components/Button";
import { useApi } from "../state/hooks";

/**
 * The banner above every screen while a recovery key was created and not yet confirmed as saved (DASH-RCV-029, settings-store
 * STORE-KEY-010): it names `mise run config:key -- --show`, and "I have saved it" clears the flag through the gate. The key
 * itself never reaches the page.
 */
// @spec DASH-RCV-029
export function RecoveryKeyBanner() {
  const api = useApi();
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void api.get<{ active: boolean; recoveryKeyUnconfirmed?: boolean }>("/recovery").then((r) => {
      if (live && r.ok && !r.data.active && r.data.recoveryKeyUnconfirmed) setShow(true);
    });
    return () => { live = false; };
  }, [api]);
  if (!show) return null;
  const markSaved = async (): Promise<void> => {
    setBusy(true);
    const r = await api.post("/recovery/key-confirmed", undefined, { auth: "control", action: "Confirm the recovery key is saved" });
    setBusy(false);
    if (r.ok) { setShow(false); return; }
    setError(r.detail || `Failed (${r.status}).`);
  };
  return (
    <Banner tone="warn" title="A recovery key was created and has not been saved"
      actions={<Button busy={busy} disabled={busy} onClick={() => void markSaved()}>I have saved it</Button>}>
      <p>The settings store made a new master key. Print its recovery key with <code>mise run config:key -- --show</code> in the cohost folder and keep it in your password manager: it is the only way to read the stored credentials if the key file is lost.</p>
      {error ? <p role="alert">{error}</p> : null}
    </Banner>
  );
}
