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
 * A browser already turns Esc inside a modal into the `cancel` event; this also closes the open dialog when focus is
 * outside it, by sending the same event.
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
        if (dialog && !dialog.contains(target)) dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
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
