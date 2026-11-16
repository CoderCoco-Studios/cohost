import { useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { Button } from "./Button";
import { Icon } from "./Icon";

export type CloseReason = "cancel" | "close";

export interface DialogProps {
  open: boolean;
  title: string;
  /** Called when the dialog asks to close: Esc (the `cancel` event) or the browser closing it. The host sets `open` false. */
  onClose: (reason: CloseReason) => void;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
  /**
   * Whether a click on the backdrop closes it, as a cancel. One rule for every dialog and sheet: only one that holds no input
   * the operator could lose closes (an informational dialog such as the shortcut list). A dialog or sheet with fields
   * (the Access dialog, the test sheet, a reason prompt) or a question (a confirmation) never closes on a backdrop click, so a
   * stray click cannot discard typed text or answer a confirmation. Default false.
   */
  backdropClose?: boolean;
  /** A CSS selector inside the dialog for the element that takes focus on open (default: `[data-autofocus]`, then the first control of the body or footer, the header's Close last). */
  initialFocus?: string;
}

const FOCUSABLE = 'input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

/** The modal dialogs this module opened, oldest first: the browser's top layer stacks them in this order, not in document order. */
const stack: HTMLDialogElement[] = [];

/**
 * The top-most open modal `<dialog>`: the one opened last. A dialog this module did not open (none today) ranks by document
 * order below those it did.
 */
export function topModal(): HTMLDialogElement | undefined {
  const mine = stack.filter((d) => d.open);
  return mine[mine.length - 1] ?? [...document.querySelectorAll<HTMLDialogElement>("dialog[open]")].pop();
}

/** Puts focus back where the operator was: the opener, or when it is gone or refuses focus, the screen heading. */
function restoreFocus(opener: HTMLElement | null): void {
  if (opener?.isConnected) { opener.focus(); if (document.activeElement === opener) return; }
  document.querySelector<HTMLElement>("h1[tabindex]")?.focus();
}

function ModalDialog({ title, onClose, children, footer, className, initialFocus, backdropClose }: Omit<DialogProps, "open">) {
  const ref = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const unmounting = useRef(false);
  const pressedOnBackdrop = useRef(false);
  useLayoutEffect(() => {
    const d = ref.current!;
    unmounting.current = false;
    const opener = document.activeElement as HTMLElement | null;
    if (!d.open) d.showModal();
    if (!stack.includes(d)) stack.push(d);
    const target = (initialFocus ? d.querySelector<HTMLElement>(initialFocus) : null) ?? d.querySelector<HTMLElement>("[data-autofocus]") ?? [...d.querySelectorAll<HTMLElement>(FOCUSABLE)].find((el) => !el.closest(".dialog-h")) ?? d.querySelector<HTMLElement>(FOCUSABLE) ?? d;
    target.focus();
    return () => {
      const i = stack.indexOf(d); if (i >= 0) stack.splice(i, 1);
      // A modal dialog makes everything behind it inert, and an inert element refuses focus: close it first, then restore.
      unmounting.current = true;
      if (d.open) d.close();
      restoreFocus(opener);
    };
  }, [initialFocus]);
  return (
    <dialog ref={ref} className={`dialog${className ? ` ${className}` : ""}`} aria-labelledby={headingId} tabIndex={-1}
      onCancel={(e) => { e.preventDefault(); closeRef.current("cancel"); }} onClose={(e) => {
        // A browser queues the close event of `close()`: in development the double run of the effect (setup, cleanup, setup)
        // reopens the dialog before the event of the first cleanup fires. A close event of a dialog that is open is stale.
        if (!unmounting.current && !e.currentTarget.open) closeRef.current("close");
      }}
      onMouseDown={(e) => { pressedOnBackdrop.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (backdropClose && e.target === e.currentTarget && pressedOnBackdrop.current) closeRef.current("cancel"); pressedOnBackdrop.current = false; }}>
      <div className="dialog-h">
        <h2 id={headingId}>{title}</h2>
        <Button variant="ghost" size="sm" className="dialog-close" onClick={() => closeRef.current("cancel")}><Icon name="close" />Close</Button>
      </div>
      <div className="dialog-b">{children}</div>
      {footer ? <div className="dialog-f">{footer}</div> : null}
    </dialog>
  );
}

/**
 * A native modal `<dialog>` (`showModal()`): named by its heading, focus moves into it on open and returns to the control
 * that opened it once it has closed (the screen heading when that control is gone), Esc, the header's Close button and,
 * where `backdropClose` is set (informational dialogs only), a click on the backdrop close it as a cancel, the browser traps focus
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
