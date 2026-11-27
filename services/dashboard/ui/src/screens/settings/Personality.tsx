import { useEffect, useId, useState } from "react";
import { Button } from "../../components/Button";
import { ConfirmDialog } from "../../components/Dialog";
import { ActionStatus } from "../../components/ActionStatus";
import { ErrorState, LoadingState } from "../../components/StateBlocks";
import { PERSONALITY_CAP, personalityBytes, useSettings, useSettingsState } from "./store";

const lineCount = (t: string): number => (t === "" ? 0 : t.split("\n").length - (t.endsWith("\n") ? 1 : 0));

/**
 * The personality editor, a page of the Settings screen (design: Personality). While the load has not succeeded the editor
 * is empty and locked with the reason and Retry, and Save is off, so an empty editor can never overwrite the file; it shows
 * the line count and the size against the 64 KiB cap; Save (or Ctrl+S) reports success only after a 2xx.
 */
// @spec DASH-SET-014, DASH-SET-015, DASH-NAV-004
export function Personality() {
  const settings = useSettings();
  const p = useSettingsState((s) => s.personality);
  const id = useId();
  const [confirming, setConfirming] = useState(false);
  useEffect(() => { void settings.loadPersonality(); }, [settings]);
  const ready = p.status === "ready";
  const bytes = ready ? personalityBytes(p.text) : 0;
  const over = bytes > PERSONALITY_CAP;
  const dirty = ready && p.text !== p.loaded;
  const save = () => { if (ready && dirty && !over) void settings.savePersonality(); };
  const reload = async () => { setConfirming(false); await settings.loadPersonality(true); };
  return (
    <section className="card" aria-label="Personality">
      <div className="card-h">
        <span className="small muted">personality · the prompt that makes the co-host who they are</span>
        <span className="grow" />
        {dirty ? <span className="tag">edited</span> : null}
      </div>
      <div className="card-b stack-y">
        <p className="note note-ok"><b>Applies at once.</b> Saving reloads the co-host's brain with the new text. No service restarts, unlike the other sections.</p>
        {p.status === "loading" ? <LoadingState label="Loading personality…" /> : null}
        {p.status === "error" ? <ErrorState message={`Could not load the personality: ${p.error}`} onRetry={() => void settings.loadPersonality()} /> : null}
        <div>
          <label className="label" htmlFor={id}>Personality</label>
          <textarea id={id} className="field mono pers" spellCheck={false} readOnly={!ready} value={p.text} aria-describedby={`${id}-meta`}
            onChange={(e) => settings.setPersonalityText(e.target.value)}
            onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); save(); } }} />
          <p className="help" id={`${id}-meta`}>
            {ready ? `${lineCount(p.text)} ${lineCount(p.text) === 1 ? "line" : "lines"} · ${(bytes / 1024).toFixed(1)} KiB of 64 KiB` : "Locked until the file loads."}
            {over ? <span className="field-error">{" Text is over the 64 KiB cap; shorten it to save."}</span> : null}
          </p>
        </div>
      </div>
      <div className="savebar">
        <div className="grow">
          <ActionStatus state={p.status === "ready" && p.failure ? { kind: "error", message: p.failure, status: 0, locked: false } : p.status === "ready" && p.message ? { kind: "ok", message: p.message } : { kind: "idle" }} />
        </div>
        <Button variant="ghost" disabled={!ready} onClick={() => (dirty ? setConfirming(true) : void reload())}>Reload</Button>
        <Button variant="primary" disabled={!ready || !dirty || over} busy={ready && p.saving} onClick={save}>Save <span className="kbd" aria-hidden="true">Ctrl S</span></Button>
      </div>
      <ConfirmDialog open={confirming} title="Discard your unsaved text?" confirmLabel="Discard and reload" danger onCancel={() => setConfirming(false)} onConfirm={() => void reload()}>
        Reloading reads the saved personality again and replaces the text you changed.
      </ConfirmDialog>
    </section>
  );
}
