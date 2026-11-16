import { Dialog } from "../components/Dialog";

export const SHORTCUTS: readonly { keys: string; does: string }[] = [
  { keys: "/", does: "Open Live and focus the Say field" },
  { keys: "1–4", does: "Open Live, Services, Viewers, Settings" },
  { keys: "m", does: "Mute or unmute the co-host" },
  { keys: "Esc", does: "Close the open dialog" },
  { keys: "?", does: "Show this list" },
];

/** The `?` dialog: every keyboard shortcut (DASH-NAV-003). */
export function ShortcutHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} title="Keyboard shortcuts" onClose={onClose} backdropClose>
      <dl className="shortcuts">
        {SHORTCUTS.map((s) => (<div key={s.keys} className="row"><dt><kbd className="kbd">{s.keys}</kbd></dt><dd>{s.does}</dd></div>))}
      </dl>
      <p className="help">Shortcuts are off while you type in a field, with Ctrl, Alt or Meta held, and while a dialog is open.</p>
    </Dialog>
  );
}
