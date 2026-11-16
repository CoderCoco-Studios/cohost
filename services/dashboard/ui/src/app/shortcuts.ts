import { useEffect, useRef } from "react";

export interface ShortcutActions {
  /** `/`: open Live and focus the Say field. */
  say(): void;
  /** `1` to `4`: open the view at that position. */
  view(index: number): void;
  mute(): void;
  help(): void;
}

const EDITABLE = "input, textarea, select, [contenteditable=''], [contenteditable='true']";

/**
 * Global keyboard shortcuts (DASH-NAV-003): `/`, `1`-`4`, `m`, `Esc`, `?`. They do nothing while focus is in an input,
 * textarea, select or editable element, with Ctrl, Alt or Meta held, or (except `Esc`) while a modal dialog is open.
 * Esc closes the open dialog by sending it the `cancel` event itself and cancelling the key's default, so the result is
 * the same in a browser (where Esc would also fire `cancel`) and in the emulated DOM (which has no native Esc).
 */
// @spec DASH-NAV-003
export function useShortcuts(actions: ShortcutActions): void {
  const ref = useRef(actions);
  ref.current = actions;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.altKey || e.metaKey || e.defaultPrevented) return;
      const target = e.target as Element | null;
      const dialog = document.querySelector<HTMLDialogElement>("dialog[open]");
      if (e.key === "Escape") {
        if (dialog) { e.preventDefault(); dialog.dispatchEvent(new Event("cancel", { cancelable: true })); }
        return;
      }
      if (dialog || target?.closest?.(EDITABLE) || (target as HTMLElement | null)?.isContentEditable) return;
      const a = ref.current;
      if (e.key === "/") { e.preventDefault(); a.say(); }
      else if (e.key >= "1" && e.key <= "4") a.view(Number(e.key) - 1);
      else if (e.key === "m") a.mute();
      else if (e.key === "?") a.help();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
}
