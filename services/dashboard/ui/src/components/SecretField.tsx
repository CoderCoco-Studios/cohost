import { useId, useState, type ReactNode } from "react";
import { Button } from "./Button";
import { ConfirmDialog } from "./Dialog";

export interface SecretFieldProps {
  label: string;
  /** Whether a value is stored. The component can only show this; a saved secret is never read back. */
  isSet: boolean;
  /** Sends the typed value. Return `false` (or reject) to keep the typed text after a failure; anything else clears the field. */
  onSave: (value: string) => void | boolean | Promise<void | boolean>;
  onClear: () => void | Promise<unknown>;
  busy?: boolean;
  help?: ReactNode;
  /** The failure of the last save or clear, shown beside the field. */
  error?: ReactNode;
}

/**
 * A secret setting: its state as Set or Not set, a masked field for a new value with Show and Hide, Save, and (when set)
 * Clear behind a confirmation. It holds only what the operator typed and has no `value` prop: a saved secret is never
 * displayed (DASH-SET-009, DASH-SECRET-007).
 */
// @spec DASH-SET-009
export function SecretField({ label, isSet, onSave, onClear, busy, help, error }: SecretFieldProps) {
  const id = useId();
  const [typed, setTyped] = useState("");
  const [shown, setShown] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const describedBy = [help ? `${id}-help` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;
  const save = async () => {
    let ok: void | boolean = true;
    try { ok = await onSave(typed); } catch { ok = false; }
    if (ok !== false) setTyped("");
  };
  return (
    <div className="secret-field">
      <label className="label" htmlFor={id}>{label}</label>
      <div className="secret">
        <input id={id} className="field" type={shown ? "text" : "password"} autoComplete="off" spellCheck={false} value={typed} placeholder={isSet ? "Type a new value to replace it" : "Type the value"}
          aria-describedby={describedBy} aria-invalid={error ? true : undefined} onChange={(e) => setTyped(e.target.value)} />
        <Button aria-pressed={shown} onClick={() => setShown((s) => !s)}>{shown ? "Hide" : "Show"}</Button>
        <Button variant="primary" onClick={save} disabled={typed.trim() === ""} busy={busy}>Save secret</Button>
        {isSet ? <Button variant="danger" onClick={() => setConfirming(true)} disabled={busy}>Clear</Button> : null}
      </div>
      <p className="help"><span className={`tag ${isSet ? "tag-set" : ""}`}>{isSet ? "Set" : "Not set"}</span></p>
      {help ? <p className="help" id={`${id}-help`}>{help}</p> : null}
      {error ? <p className="help field-error" id={`${id}-error`}>{error}</p> : null}
      <ConfirmDialog open={confirming} title={`Clear ${label}?`} confirmLabel="Clear" danger onCancel={() => setConfirming(false)}
        onConfirm={() => { setConfirming(false); void onClear(); }}>
        The stored value is removed and {label} reads as not set. The service that uses it must restart to notice.
      </ConfirmDialog>
    </div>
  );
}
