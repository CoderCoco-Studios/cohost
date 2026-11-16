import { useId, useState, type FormEvent } from "react";
import { Banner } from "../../components/Banner";
import { Button } from "../../components/Button";
import { useAccess, useApi } from "../../state/hooks";
import type { Scope } from "../../state/access";
import type { TokenKind } from "../../state/types";
import { checkToken } from "./check";
import { CopyCommand } from "./CopyCommand";
import { SetupSteps } from "./SetupSteps";
import { CONTROL_FIND, ENV_NAME, TOKEN_LABEL, UNLOCKS, VIEWERS_LINE } from "./text";

export interface TokenFormProps {
  kind: TokenKind;
  /** The waiting action ("Restart voice"), when a request is waiting for this token. */
  action?: string;
  /** The server rejected the token this page held, so it was forgotten (DASH-ACC-006). */
  rejected?: boolean;
  /** The token was checked and stored (and, when storage is unavailable, the operator has read the note). */
  onStored: () => void;
  onCancel: () => void;
}

type Result = { kind: "rejected" } | { kind: "failed"; message: string } | { kind: "not-set-up" } | { kind: "memory" } | null;

function Checks({ kind }: { kind: TokenKind }) {
  return (
    <ul className="checks">
      <li>Copy the whole value after <code>{ENV_NAME[kind]}=</code>, with no spaces or quotes.</li>
      <li>If <code>.env</code> changed after the dashboard started, restart the dashboard.</li>
    </ul>
  );
}

/**
 * The masked field, the instructions and the check for one token. The typed value lives only in this component's state,
 * so it is gone when the dialog closes (DASH-ACC-012). A submitted token is trimmed and checked against the server; it is
 * stored only after the server accepted it, in this tab or, when chosen, this browser (DASH-ACC-004, DASH-ACC-007).
 */
// @spec DASH-ACC-003, DASH-ACC-004, DASH-ACC-005, DASH-ACC-007, DASH-ACC-012
export function TokenForm({ kind, action, rejected, onStored, onCancel }: TokenFormProps) {
  const api = useApi();
  const { access } = useAccess();
  const id = useId();
  const [typed, setTyped] = useState("");
  const [shown, setShown] = useState(false);
  const [scope, setScope] = useState<Scope>("tab");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result>(null);
  const [pasteNote, setPasteNote] = useState("");
  const label = TOKEN_LABEL[kind];
  const env = ENV_NAME[kind];

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const token = typed.trim();
    if (token === "" || busy) return;
    setBusy(true);
    setResult(null);
    const outcome = await checkToken(api, kind, token);
    setBusy(false);
    if (outcome.kind === "accepted") {
      access.markNotSetUp(kind, false);
      access.setToken(kind, token, scope);
      if (access.state.get().memoryOnly) setResult({ kind: "memory" });
      else onStored();
      return;
    }
    if (outcome.kind === "not-set-up") access.markNotSetUp(kind, true);
    setResult(outcome);
  };

  const paste = async () => {
    try {
      if (!navigator.clipboard?.readText) throw new Error("no clipboard");
      setTyped(await navigator.clipboard.readText());
      setPasteNote("");
    } catch { setPasteNote("Paste is not available here. Click the field and press Ctrl+V."); }
  };

  const stored = result?.kind === "memory";
  return (
    <form className="token-form" onSubmit={(e) => void submit(e)} noValidate>
      {action ? <p>{action} is waiting. It runs as soon as the page is unlocked.</p> : null}
      {rejected ? (
        <Banner tone="warn" title="The saved token was rejected">
          The dashboard no longer accepts the {label.toLowerCase()} this page held, so it was forgotten. Enter it again.
          <Checks kind={kind} />
        </Banner>
      ) : null}
      <p className="help">{UNLOCKS[kind]}</p>

      <div>
        <label className="label" htmlFor={`${id}-field`}>{label}</label>
        <div className="secret">
          <input id={`${id}-field`} className="field" data-autofocus type={shown ? "text" : "password"} autoComplete="off" spellCheck={false} value={typed}
            aria-describedby={result && result.kind !== "memory" ? `${id}-result` : undefined} aria-invalid={result?.kind === "rejected" || result?.kind === "failed" ? true : undefined}
            readOnly={stored} onChange={(e) => setTyped(e.target.value)} />
          <Button aria-pressed={shown} onClick={() => setShown((s) => !s)}>{shown ? "Hide" : "Show"}</Button>
          <Button onClick={() => void paste()} disabled={stored}>Paste</Button>
        </div>
        {pasteNote ? <p className="help" role="status">{pasteNote}</p> : null}
      </div>

      <fieldset className="stay">
        <legend className="label">Stay unlocked</legend>
        <label className="check"><input type="radio" name={`${id}-scope`} checked={scope === "tab"} onChange={() => setScope("tab")} disabled={stored} />This tab</label>
        <label className="check"><input type="radio" name={`${id}-scope`} checked={scope === "browser"} onChange={() => setScope("browser")} disabled={stored} />This browser</label>
        <p className="help">{scope === "browser" ? "The token stays in this browser until the page is locked, including after you close it." : "The token is forgotten when this tab closes."}</p>
      </fieldset>

      <div id={`${id}-result`}>
        {result?.kind === "rejected" ? (
          <Banner tone="bad">
            The dashboard rejected this token. Nothing was changed.
            <Checks kind={kind} />
          </Banner>
        ) : null}
        {result?.kind === "failed" ? <Banner tone="bad">The token could not be checked: {result.message}. Nothing was changed.</Banner> : null}
        {result?.kind === "not-set-up" ? (
          <Banner tone="warn" title="Not set up on the server">
            {kind === "control" ? (
              <>The dashboard has no control token. Set <code>CONTROL_TOKEN</code> in <code>.env</code> (<code>CONTROL_ENABLED</code> does not have to be 1) and restart the dashboard. Nothing was changed.</>
            ) : (
              <>The dashboard has no viewers token, so no token can unlock the Viewers screen yet. Nothing was changed.<SetupSteps /></>
            )}
          </Banner>
        ) : null}
        {result?.kind === "memory" ? (
          <Banner tone="warn" title="Unlocked for this page only">
            This browser blocks storage, so the token is kept in memory and you will be asked for again after a reload.
          </Banner>
        ) : null}
      </div>

      <details open={!!action || undefined} className="find">
        <summary>Where do I find it?</summary>
        {kind === "control" ? (
          <>
            <p className="help">The installer generated it. In the cohost folder, run this command and paste the value after the equals sign.</p>
            <CopyCommand text={CONTROL_FIND} />
          </>
        ) : (
          <>
            <p className="help">The installer does not generate it. In the cohost folder, add this line to <code>.env</code>, restart the dashboard so it reads the new value, then paste the value here. Read it back with <code>grep ^VIEWERS_TOKEN= .env</code>.</p>
            <CopyCommand text={VIEWERS_LINE} />
          </>
        )}
      </details>

      <details className="where">
        <summary>Where these are set</summary>
        <p className="help">
          <code>CONTROL_TOKEN</code>, <code>CONTROL_ENABLED</code>, <code>CONTROL_ADVANCED</code>, <code>DASHBOARD_HOST</code> and <code>VIEWERS_TOKEN</code> are set in <code>.env</code>, in the cohost folder.
          The dashboard reads them once when the dashboard starts, so a change takes effect only after it restarts.
          This dialog never sets them: it only checks a token you paste and remembers it for this page.
        </p>
      </details>

      <div className="row form-actions">
        {stored ? (
          <Button type="button" variant="primary" onClick={onStored}>Continue</Button>
        ) : (
          <>
            <Button type="submit" variant="primary" busy={busy} disabled={typed.trim() === ""}>Unlock</Button>
            <Button onClick={onCancel}>Cancel</Button>
          </>
        )}
        <span className="sr-only" role="status">{busy ? `Checking the ${env}` : ""}</span>
      </div>
    </form>
  );
}
