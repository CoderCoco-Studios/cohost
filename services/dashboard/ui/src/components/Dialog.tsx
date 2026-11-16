import { useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { Button } from "./Button";

export type CloseReason = "cancel" | "close";

export interface DialogProps {
  open: boolean;
  title: string;
  /** Called when the dialog asks to close: Esc (the `cancel` event) or the browser closing it. The host sets `open` false. */
  onClose: (reason: CloseReason) => void;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
  /** A CSS selector inside the dialog for the element that takes focus on open (default: `[data-autofocus]`, then the first control). */
  initialFocus?: string;
}

const FOCUSABLE = 'input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

function ModalDialog({ title, onClose, children, footer, className, initialFocus }: Omit<DialogProps, "open">) {
  const ref = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useLayoutEffect(() => {
    const d = ref.current!;
    const opener = document.activeElement as HTMLElement | null;
    if (!d.open) d.showModal();
    const target = (initialFocus ? d.querySelector<HTMLElement>(initialFocus) : null) ?? d.querySelector<HTMLElement>("[data-autofocus]") ?? d.querySelector<HTMLElement>(FOCUSABLE) ?? d;
    target.focus();
    return () => { if (opener?.isConnected) opener.focus(); };
  }, [initialFocus]);
  return (
    <dialog ref={ref} className={`dialog${className ? ` ${className}` : ""}`} aria-labelledby={headingId} tabIndex={-1}
      onCancel={(e) => { e.preventDefault(); closeRef.current("cancel"); }} onClose={() => closeRef.current("close")}>
      <div className="dialog-h"><h2 id={headingId}>{title}</h2></div>
      <div className="dialog-b">{children}</div>
      {footer ? <div className="dialog-f">{footer}</div> : null}
    </dialog>
  );
}

/**
 * A native modal `<dialog>` (`showModal()`): named by its heading, focus moves into it on open and returns to the control
 * that opened it on close, Esc arrives as the `cancel` event and closes it as a cancel, the browser traps focus
 * (DASH-A11Y-005, DASH-ACC-011). Nothing is rendered while closed, so typed text is gone when it reopens (DASH-ACC-012).
 * The page behind keeps running: dialogs never block the feed or the audio sink.
 */
// @spec DASH-A11Y-005, DASH-ACC-011, DASH-UI-033
export function Dialog({ open, ...rest }: DialogProps) {
  return open ? <ModalDialog {...rest} /> : null;
}

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  children?: ReactNode;
  /** The confirm button's text, naming the action ("Restart voice"). */
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  /** While set the confirm button is disabled and this reason is shown ("A stack action is running."). */
  disabledReason?: string;
  /** A request is in flight: confirm is disabled and busy. */
  busy?: boolean;
  /** A failure of the request the dialog sent; shown inside the dialog, which stays open. */
  error?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/** A yes-or-no dialog: Cancel and a confirm button that names the action. Never `window.confirm` (DASH-UI-033). */
// @spec DASH-UI-033, DASH-UI-008
export function ConfirmDialog({ open, title, children, confirmLabel, cancelLabel = "Cancel", danger, disabledReason, busy, error, onConfirm, onCancel }: ConfirmDialogProps) {
  return (
    <Dialog open={open} title={title} onClose={() => onCancel()}
      footer={<><Button onClick={onCancel}>{cancelLabel}</Button><Button variant={danger ? "danger" : "primary"} onClick={onConfirm} disabled={!!disabledReason} busy={busy}>{confirmLabel}</Button></>}>
      {children}
      {disabledReason ? <p className="help">{disabledReason}</p> : null}
      {error ? <p className="action-error" role="alert">{error}</p> : null}
    </Dialog>
  );
}
