import { useState, type ReactNode } from "react";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { TextField } from "../../components/Field";

export interface ReasonDialogProps {
  title: string;
  children?: ReactNode;
  /** The label of the field: "Reason (optional)", "Chat viewer's name". */
  fieldLabel: string;
  fieldHelp?: ReactNode;
  /** A value is required: the confirm button is disabled while the field is blank. */
  required?: boolean;
  confirmLabel: string;
  /** The cancel button's text (default Cancel). */
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  /** The failure of the request the dialog sent; the dialog stays open and shows it. */
  error?: string;
  /** Called with the trimmed text (possibly empty when the field is optional). */
  onConfirm: (text: string) => void;
  onCancel: () => void;
}

/**
 * A confirmation dialog with one text field: an optional reason for a deletion, or the required name of a chat viewer.
 * Nothing is sent until it is confirmed; Cancel and Esc send nothing. The typed text is gone when it closes.
 */
export function ReasonDialog({ title, children, fieldLabel, fieldHelp, required, confirmLabel, cancelLabel = "Cancel", danger, busy, error, onConfirm, onCancel }: ReasonDialogProps) {
  const [text, setText] = useState("");
  const blank = text.trim() === "";
  const submit = () => { if (!(required && blank) && !busy) onConfirm(text.trim()); };
  return (
    <Dialog open title={title} onClose={() => onCancel()} initialFocus="input"
      footer={<><Button onClick={onCancel}>{cancelLabel}</Button><Button variant={danger ? "danger" : "primary"} onClick={submit} disabled={required && blank} busy={busy}>{confirmLabel}</Button></>}>
      {children}
      <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <TextField label={fieldLabel} help={fieldHelp} value={text} onChange={setText} autoComplete="off" />
      </form>
      {error ? <p className="action-error" role="alert">{error}</p> : null}
    </Dialog>
  );
}
