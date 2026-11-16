import { useEffect, useRef, useState } from "react";
import { ActionStatus } from "../../components/ActionStatus";
import { Button } from "../../components/Button";
import { ConfirmDialog } from "../../components/Dialog";
import { EmptyState, ErrorState, LoadingState } from "../../components/StateBlocks";
import { Meter } from "../../components/Meter";
import { Switch } from "../../components/Switch";
import { useAction, useApi } from "../../state/hooks";
import type { ApiResult } from "../../state/api";
import { useStale } from "../../app/connection";
import { MemoryExplainer } from "./MemoryExplainer";
import { percentOf, whatNext, type MemoryFigures } from "./memory";
import { ReasonDialog } from "./ReasonDialog";
import type { DeletionData, LinkData, NoteData, ViewerDetailData } from "./types";
import type { Load } from "./useViewers";

type Dlg = { kind: "delete"; note: NoteData } | { kind: "clear" } | { kind: "link" } | { kind: "unlink"; link: LinkData } | null;
const enc = encodeURIComponent;
const gate = (action: string) => ({ auth: "viewers" as const, action });
const narrow = (): boolean => { try { return window.matchMedia?.("(max-width: 719.98px)").matches === true; } catch { return false; } };

function NoteItem({ note, figures, onDelete }: { note: NoteData; figures: MemoryFigures | null; onDelete: () => void }) {
  const next = whatNext(note, figures);
  return (
    <li className="note-item">
      <div className="row"><p className="wrap note-text">{note.text}</p><span className="tag">{note.category}</span></div>
      <div className="row">
        <Meter label="Memory strength" percent={percentOf(note.strength)} />
        {next ? <span className="help">{next}</span> : null}
        <Button size="sm" variant="danger" aria-label={`Delete note: ${note.text}`} onClick={onDelete}>Delete</Button>
      </div>
    </li>
  );
}

function Group({ title, sub, notes, figures, onDelete }: { title: string; sub: string; notes: NoteData[]; figures: MemoryFigures | null; onDelete: (n: NoteData) => void }) {
  return (
    <section className="notes-group">
      <h3>{title}</h3>
      <p className="help">{sub}</p>
      {notes.length ? <ul className="notes">{notes.map((n) => <NoteItem key={n.id} note={n} figures={figures} onDelete={() => onDelete(n)} />)}</ul> : <p className="muted small">None</p>}
    </section>
  );
}

function Deleted({ items, onUndo, busy }: { items: DeletionData[]; onUndo: (d: DeletionData) => void; busy: boolean }) {
  return (
    <section className="notes-group">
      <h3>Deleted notes</h3>
      {items.length ? (
        <ul className="notes">
          {items.map((d) => (
            <li key={d.id} className="note-item">
              <div className="row"><p className="wrap note-text">{d.text}</p><span className="tag">{d.category}</span></div>
              <div className="row">
                <span className="help">{d.reason ? `Reason: ${d.reason}` : "no reason"}</span>
                <Button size="sm" aria-label={`Undo deleting: ${d.text}`} disabled={busy} onClick={() => onUndo(d)}>Undo</Button>
              </div>
            </li>
          ))}
        </ul>
      ) : <p className="muted small">None</p>}
    </section>
  );
}

export interface ViewerDetailProps {
  selected: string | null;
  load: Load<ViewerDetailData>;
  figures: MemoryFigures | null;
  /** Reload this panel and the list after a change. */
  onChanged: () => Promise<void>;
  /** A voice viewer was linked; the chat viewer that received its notes (when the reply names it). */
  onLinked: (targetKey?: string) => Promise<void>;
  onRetry: () => void;
  onBack: () => void;
}

/**
 * The right panel for the selected viewer: regular status and the "Always a regular" switch, the memory-strength explainer,
 * notes grouped Core, Recent and Deleted with labelled strength meters, Delete, Clear all notes and Undo, and the voice
 * links (DASH-VIEWERS-011 to -015, -020 to -022, -023). Names and note text are rendered as text only.
 */
// @spec DASH-VIEWERS-011, DASH-VIEWERS-012, DASH-VIEWERS-013, DASH-VIEWERS-014, DASH-VIEWERS-015, DASH-VIEWERS-020, DASH-VIEWERS-021, DASH-VIEWERS-022, DASH-VIEWERS-023
export function ViewerDetail({ selected, load, figures, onChanged, onLinked, onRetry, onBack }: ViewerDetailProps) {
  const api = useApi();
  const stale = useStale();
  const inline = useAction();
  const dlgAction = useAction();
  const [dlg, setDlg] = useState<Dlg>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const data = load.data;
  const key = data?.viewer.key;

  // On a narrow screen the list is hidden once a viewer is open: move focus to the panel's heading.
  useEffect(() => { if (key !== undefined && narrow()) heading.current?.focus(); }, [key]);
  useEffect(() => { setDlg(null); inline.dismiss(); }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps

  const className = `card viewers-detail-pane${stale.className ? ` ${stale.className}` : ""}`;
  if (selected === null) {
    return <section className={className} aria-label="Viewer details" aria-busy={stale["aria-busy"]}><div className="card-b"><EmptyState title="Select a viewer">What the co-host remembers about them appears here.</EmptyState></div></section>;
  }

  const open = (d: Dlg) => { dlgAction.dismiss(); setDlg(d); };
  const send = async (request: () => Promise<ApiResult<unknown>>, after?: (r: ApiResult<unknown>) => Promise<void>) => {
    const r = await dlgAction.run(request, "Done");
    if (r.ok) { setDlg(null); await (after ? after(r) : onChanged()); }
  };
  const v = data?.viewer;
  const k = v ? enc(v.key) : "";
  const regularText = v ? (v.regular ? (v.regularManual ? "Regular: set by you" : "Regular: by message count") : "Not a regular yet") : "";
  const notesEmpty = data !== undefined && data.core.length === 0 && data.recent.length === 0;

  return (
    <>
      <section className={className} aria-label="Viewer details" aria-busy={stale["aria-busy"]}>
        <div className="card-b stack-y">
          <div><Button className="back-btn" onClick={onBack}>Back to viewers</Button></div>
          {load.status === "loading" && !data ? <LoadingState label="Loading viewer…" /> : null}
          {load.status === "error" ? <ErrorState message={load.error ?? "Could not load this viewer."} onRetry={onRetry} /> : null}
          {data && v ? (
            <>
              <div className="row">
                <h2 className="wrap" tabIndex={-1} ref={heading}>{v.display}</h2>
                <span className="muted small">{v.msgCount} {v.msgCount === 1 ? "message" : "messages"}</span>
                {v.voice ? <span className="tag">VOICE</span> : null}
              </div>
              <p className="muted small">{regularText}</p>
              <div className="row">
                <Switch label="Always a regular" checked={v.regularManual} disabled={inline.state.kind === "pending"}
                  onChange={(on) => void inline.run(() => api.post("/viewers/regular", { key: v.key, regular: on }, gate("Change a viewer's regular status")), on ? "Marked as always a regular" : "No longer always a regular").then((r) => { if (r.ok) void onChanged(); })} />
                <Button onClick={() => open({ kind: "clear" })}>Clear all notes</Button>
                {v.voice ? <Button onClick={() => open({ kind: "link" })}>Link to a chat viewer</Button> : null}
                <ActionStatus state={inline.state} onDismiss={inline.dismiss} />
              </div>
              {v.voice ? <p className="help">Heard in the voice channel; not linked to a chat viewer.</p> : null}
              {data.links?.length ? (
                <section className="notes-group">
                  <h3>Linked Discord accounts</h3>
                  <ul className="notes">
                    {data.links.map((l) => (
                      <li key={l.discordId} className="note-item">
                        <div className="row">
                          <span className="wrap">{`Discord id ${l.discordId}${l.discordDisplay ? ` (${l.discordDisplay})` : ""}`}</span>
                          <span className="tag">voice</span>
                          <Button size="sm" aria-label={`Unlink Discord id ${l.discordId}`} onClick={() => open({ kind: "unlink", link: l })}>Unlink</Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
              <MemoryExplainer figures={figures} />
              {notesEmpty ? <EmptyState title="No notes yet">The co-host has not remembered anything about this viewer.</EmptyState> : (
                <>
                  <Group title="Core" sub="Long-lived" notes={data.core} figures={figures} onDelete={(n) => open({ kind: "delete", note: n })} />
                  <Group title="Recent" sub="Fade unless repeated" notes={data.recent} figures={figures} onDelete={(n) => open({ kind: "delete", note: n })} />
                </>
              )}
              <Deleted items={data.deletions} busy={inline.state.kind === "pending"}
                onUndo={(d) => void inline.run(() => api.post(`/viewers/deletions/${enc(d.id)}/restore`, {}, gate("Restore a deleted note")), "Note restored").then((r) => { if (r.ok) void onChanged(); })} />
            </>
          ) : null}
        </div>
      </section>

      {dlg?.kind === "delete" ? (
        <ReasonDialog title="Delete this note?" fieldLabel="Reason (optional)" cancelLabel="Keep note" confirmLabel="Delete note" danger busy={dlgAction.state.kind === "pending"}
          error={dlgAction.state.kind === "error" ? dlgAction.state.message : undefined} onCancel={() => setDlg(null)}
          fieldHelp="With a reason, the co-host stops re-learning similar notes about this viewer. Without one, the topic can come back, weakly, if they keep raising it."
          onConfirm={(reason) => void send(() => api.post(`/viewers/${k}/notes/${enc(dlg.note.id)}/delete`, reason ? { reason } : {}, gate("Delete a note")))}>
          <p className="wrap quoted">{dlg.note.text}</p>
          <p className="muted small">The note stays listed under Deleted notes, where it can be undone.</p>
        </ReasonDialog>
      ) : null}
      {dlg?.kind === "clear" && v ? (
        <ReasonDialog title="Clear all notes?" fieldLabel="Reason (optional)" confirmLabel="Clear all notes" danger busy={dlgAction.state.kind === "pending"}
          error={dlgAction.state.kind === "error" ? dlgAction.state.message : undefined} onCancel={() => setDlg(null)}
          fieldHelp="With a reason, the co-host stops re-learning similar notes about this viewer. Without one, the topics can come back, weakly, if they keep raising them."
          onConfirm={(reason) => void send(() => api.post(`/viewers/${k}/clear`, reason ? { reason } : {}, gate("Clear a viewer's notes")))}>
          <p className="wrap">Every note about {v.display} is deleted. Each one stays listed under Deleted notes and can be undone.</p>
        </ReasonDialog>
      ) : null}
      {dlg?.kind === "link" && v?.discordId ? (
        <ReasonDialog title="Link to a chat viewer" fieldLabel="Chat viewer's name" required confirmLabel="Link" busy={dlgAction.state.kind === "pending"}
          error={dlgAction.state.kind === "error" ? dlgAction.state.message : undefined} onCancel={() => setDlg(null)}
          fieldHelp="Type their name as it shows in chat."
          onConfirm={(name) => void send(() => api.post<{ viewer?: { key?: string } }>("/viewers/links", { discordId: v.discordId, name }, gate("Link a voice viewer")),
            async (r) => onLinked(r.ok ? (r.data as { viewer?: { key?: string } } | undefined)?.viewer?.key : undefined))}>
          <p>Their voice notes move to that viewer, and later speech from this Discord account goes there.</p>
        </ReasonDialog>
      ) : null}
      <ConfirmDialog open={dlg?.kind === "unlink"} title="Unlink this Discord account?" confirmLabel="Unlink" danger busy={dlgAction.state.kind === "pending"}
        error={dlgAction.state.kind === "error" ? dlgAction.state.message : undefined} onCancel={() => setDlg(null)}
        onConfirm={() => { if (dlg?.kind === "unlink") void send(() => api.post(`/viewers/links/${enc(dlg.link.discordId)}/delete`, {}, gate("Unlink a Discord account"))); }}>
        Later speech from this Discord account is recorded as a separate voice viewer again. Notes already moved to this viewer stay with them.
      </ConfirmDialog>
    </>
  );
}
