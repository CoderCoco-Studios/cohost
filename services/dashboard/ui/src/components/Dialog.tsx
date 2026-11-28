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
  /**
   * False while the dialog must not be dismissed (the launch progress dialog while its action runs, DASH-UI-061): no header
   * Close button, Esc and the backdrop do nothing, and a close by the browser opens it again. Default true.
   */
  dismissible?: boolean;
  /** True when the `m` mute shortcut keeps working while this dialog is the top-most one (the launch progress dialog, DASH-UI-069). */
  muteShortcut?: boolean;
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

/** The opener of each open dialog, then the openers it falls back to: an opener inside another dialog is followed by that dialog's own. */
const openers = new WeakMap<HTMLDialogElement, HTMLElement[]>();

function openerChain(opener: HTMLElement | null): HTMLElement[] {
  if (!opener || opener === document.body) return [];
  const host = opener.closest("dialog");
  return [opener, ...(host ? openers.get(host) ?? [] : [])];
}

/** Whether a control is shown: not under `hidden`, and not inside a closed `<details>` (its own `<summary>` excepted). */
function shown(el: HTMLElement): boolean {
  if (el.closest("[hidden]")) return false;
  const det = el.closest("details");
  return !det || det.open || (el.tagName === "SUMMARY" && el.parentElement === det);
}

/**
 * Focuses, in order, the dialog's `initialFocus` element, its `[data-autofocus]` element, the first shown control of its
 * body or footer, then any shown control; the dialog itself when none takes focus, so focus never stays on the inert page.
 */
function focusInto(d: HTMLDialogElement, initialFocus?: string): void {
  const controls = [...d.querySelectorAll<HTMLElement>(`${FOCUSABLE}, summary`)].filter(shown);
  const candidates = [
    initialFocus ? d.querySelector<HTMLElement>(initialFocus) : null, d.querySelector<HTMLElement>("[data-autofocus]"),
    ...controls.filter((el) => !el.closest(".dialog-h")), ...controls.filter((el) => el.closest(".dialog-h")),
  ];
  for (const el of candidates) {
    if (!el) continue;
    el.focus();
    if (document.activeElement === el) return;
  }
  d.focus();
}

/**
 * Puts focus back where the operator was: the first of the opener chain still in the page that takes focus, or the screen
 * heading. While another modal dialog is still open, focus stays inside it, since everything behind it is inert.
 */
function restoreFocus(chain: readonly HTMLElement[]): void {
  const top = topModal();
  for (const el of chain) {
    if (!el.isConnected || (top && !top.contains(el))) continue;
    el.focus();
    if (document.activeElement === el) return;
  }
  if (top) { focusInto(top); return; }
  document.querySelector<HTMLElement>("h1[tabindex]")?.focus();
}

function ModalDialog({ title, onClose, children, footer, className, initialFocus, backdropClose, dismissible = true, muteShortcut = false }: Omit<DialogProps, "open">) {
  const ref = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const dismissibleRef = useRef(dismissible);
  dismissibleRef.current = dismissible;
  const unmounting = useRef(false);
  const pressedOnBackdrop = useRef(false);
  useLayoutEffect(() => {
    const d = ref.current!;
    unmounting.current = false;
    const chain = openerChain(document.activeElement as HTMLElement | null);
    openers.set(d, chain);
    if (!d.open) d.showModal();
    if (!stack.includes(d)) stack.push(d);
    focusInto(d, initialFocus);
    return () => {
      const i = stack.indexOf(d); if (i >= 0) stack.splice(i, 1);
      // A modal dialog makes everything behind it inert, and an inert element refuses focus: close it first, then restore.
      unmounting.current = true;
      if (d.open) d.close();
      restoreFocus(chain);
    };
  }, [initialFocus]);
  return (
    <dialog ref={ref} className={`dialog${className ? ` ${className}` : ""}`} aria-labelledby={headingId} aria-modal="true" tabIndex={-1} data-mute-shortcut={muteShortcut ? "" : undefined}
      onCancel={(e) => { e.preventDefault(); if (dismissibleRef.current) closeRef.current("cancel"); }} onClose={(e) => {
        // A browser queues the close event of `close()`: in development the double run of the effect (setup, cleanup, setup)
        // reopens the dialog before the event of the first cleanup fires. A close event of a dialog that is open is stale.
        if (unmounting.current || e.currentTarget.open) return;
        // A browser may close a modal whose cancel was refused (a second Esc): one that must not be dismissed opens again.
        if (!dismissibleRef.current) {
          const d = e.currentTarget;
          d.showModal();
          // Opened again, it is on top of the browser's top layer: it moves to the end of the stack, so `topModal()` names it.
          const i = stack.indexOf(d); if (i >= 0) stack.splice(i, 1);
          stack.push(d);
          focusInto(d, initialFocus);
          return;
        }
        closeRef.current("close");
      }}
      onMouseDown={(e) => { pressedOnBackdrop.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (backdropClose && dismissibleRef.current && e.target === e.currentTarget && pressedOnBackdrop.current) closeRef.current("cancel"); pressedOnBackdrop.current = false; }}>
      <div className="dialog-h">
        <h2 id={headingId}>{title}</h2>
        {dismissible ? <Button variant="ghost" size="sm" className="dialog-close" onClick={() => closeRef.current("cancel")}><Icon name="close" />Close</Button> : null}
      </div>
      <div className="dialog-b">{children}</div>
      {footer ? <div className="dialog-f">{footer}</div> : null}
    </dialog>
  );
}

/**
 * A native modal `<dialog>` (`showModal()`): named by its heading, focus moves into it on open and returns to the control
 * that opened it once it has closed (when that control sat in a dialog that has closed since, that dialog's opener; the
 * screen heading when none is left; inside the top-most dialog while another is still open), Esc, the header's Close button and,
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
