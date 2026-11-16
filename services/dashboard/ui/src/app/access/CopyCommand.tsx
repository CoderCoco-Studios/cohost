import { useRef, useState } from "react";
import { Button } from "../../components/Button";

/**
 * A command in a `<code>` element with a Copy button. Copy writes to the clipboard; when the clipboard API is missing or
 * refuses, it selects the command's text so the operator can copy it by hand (DASH-ACC-003).
 */
// @spec DASH-ACC-003
export function CopyCommand({ text }: { text: string }) {
  const ref = useRef<HTMLElement>(null);
  const [note, setNote] = useState("");
  const select = () => {
    const sel = window.getSelection();
    if (!sel || !ref.current) return;
    const range = document.createRange();
    range.selectNodeContents(ref.current);
    sel.removeAllRanges();
    sel.addRange(range);
  };
  const copy = async () => {
    try {
      if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); setNote("Copied."); return; }
    } catch { /* fall through to selecting the text */ }
    select();
    setNote("Selected. Press Ctrl+C to copy it by hand.");
  };
  return (
    <div className="copy-command">
      <code ref={ref} className="cmd">{text}</code>
      <Button size="sm" onClick={() => void copy()}>Copy</Button>
      <span className="help" role="status">{note}</span>
    </div>
  );
}
